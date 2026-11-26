import { createHash } from 'node:crypto';
import { extractFrontmatter, extractSupersedes } from './CatCafeScanner.js';
import type { CollectionManifest } from './collection-types.js';
import { embedIndexedItems } from './embed-utils.js';
import type { EvidenceItem, IEmbeddingService, RepoScanner, ScannedEvidence } from './interfaces.js';
import { stripYamlFrontmatter } from './MarkdownPassageIndexer.js';
import type { SecretFinding } from './SecretScanner.js';
import { SecretScanner } from './SecretScanner.js';
import type { SqliteEvidenceStore } from './SqliteEvidenceStore.js';
import type { VectorStore } from './VectorStore.js';

export interface CollectionRebuildResult {
  indexed: number;
  skipped: number;
  blocked: boolean;
  secretFindings: SecretFinding[];
}

export interface CollectionEmbedDeps {
  getEmbeddingService: () => IEmbeddingService | undefined;
  vectorStore: VectorStore;
}

function createLiveEmbeddingCapability(getEmbeddingService: () => IEmbeddingService | undefined): IEmbeddingService {
  const requireService = (): IEmbeddingService => {
    const service = getEmbeddingService();
    if (!service) throw new Error('Embedding capability is no longer active');
    return service;
  };

  return {
    load: () => requireService().load(),
    embed: (texts) => requireService().embed(texts),
    isReady: () => getEmbeddingService()?.isReady() === true,
    reprobeIfNeeded: async () => {
      const service = getEmbeddingService();
      if (service) await service.reprobeIfNeeded();
    },
    getModelInfo: () => requireService().getModelInfo(),
    // The builder borrows the lifecycle-owned service and must never dispose it.
    dispose: () => {},
  };
}

export class CollectionIndexBuilder {
  constructor(
    private readonly store: SqliteEvidenceStore,
    private readonly manifest: CollectionManifest,
    private readonly scanner: RepoScanner,
    private readonly embedDeps?:
      | CollectionEmbedDeps
      | (() => CollectionEmbedDeps | undefined | Promise<CollectionEmbedDeps | undefined>),
  ) {
    this.store.setSourceRoot(this.manifest.root, this.manifest.id);
  }

  async rebuild(options?: { force?: boolean }): Promise<CollectionRebuildResult> {
    const force = options?.force ?? false;
    const results = this.scanner.discover(this.manifest.root);

    const { findings } = SecretScanner.scanBatch(
      results.map((r) => ({ path: r.item.sourcePath ?? r.item.anchor, content: r.rawContent })),
    );

    if (findings.length > 0) {
      await this.purgeCollection();
      return { indexed: 0, skipped: 0, blocked: true, secretFindings: findings };
    }

    const { indexed, skipped, indexedItems } = await this.indexResults(results, force);
    await this.replaceFrontmatterSupersedesEdges(results);

    if (this.embedDeps) {
      try {
        const deps = typeof this.embedDeps === 'function' ? await this.embedDeps() : this.embedDeps;
        if (!deps) return { indexed, skipped, blocked: false, secretFindings: [] };
        const { getEmbeddingService, vectorStore } = deps;
        const embedding = createLiveEmbeddingCapability(getEmbeddingService);
        const store = this.store;
        await embedIndexedItems({
          items: indexedItems,
          sourceStore: this.store,
          embedding,
          vectorStore,
          allDocsProvider: () => {
            const db = store.getDb();
            const prefix = `${this.manifest.id}:`;
            const allDocs = db
              .prepare('SELECT anchor, title, summary FROM evidence_docs WHERE anchor LIKE ?')
              .all(`${prefix}%`) as Array<{ anchor: string; title: string; summary: string | null }>;
            return allDocs.map(
              (d) => ({ anchor: d.anchor, title: d.title, summary: d.summary ?? undefined }) as EvidenceItem,
            );
          },
        });
      } catch {
        // fail-open: embedding errors don't block indexing
      }
    }

    return { indexed, skipped, blocked: false, secretFindings: [] };
  }

  async incrementalUpdate(changedPaths: string[]): Promise<void> {
    if (!('parseSingle' in this.scanner && typeof this.scanner.parseSingle === 'function')) return;
    const parseSingle = (
      this.scanner as { parseSingle(f: string, r: string): ScannedEvidence | null }
    ).parseSingle.bind(this.scanner);
    const scannedEntries: ScannedEvidence[] = [];
    for (const filePath of changedPaths) {
      const scanned = parseSingle(filePath, this.manifest.root);
      if (scanned) scannedEntries.push(scanned);
    }
    if (scannedEntries.length === 0) return;

    // Mirror rebuild()'s fail-closed SecretScanner gate before persisting metadata or body passages.
    const { findings } = SecretScanner.scanBatch(
      scannedEntries.map((r) => ({ path: r.item.sourcePath ?? r.item.anchor, content: r.rawContent })),
    );
    if (findings.length > 0) {
      await this.purgeCollection();
      throw new Error(
        `Collection ${this.manifest.id} incremental update blocked by SecretScanner (${findings.length} finding(s))`,
      );
    }

    const now = new Date().toISOString();
    for (const scanned of scannedEntries) {
      const hash = createHash('sha256').update(scanned.rawContent).digest('hex');
      const item: EvidenceItem = {
        ...scanned.item,
        sourceHash: hash,
        updatedAt: now,
        authority: this.manifest.reviewPolicy.authorityCeiling,
      };
      await this.publishDocumentWithBody(item, this.extractLexicalBody(scanned));
      await this.refreshFrontmatterSupersedesEdges(item.anchor, scanned.rawContent);
    }
  }

  private extractLexicalBody(result: ScannedEvidence): string {
    if (result.rawContent) {
      return stripYamlFrontmatter(result.rawContent).trim();
    }
    return result.passages.join('\n\n').trim();
  }

  private hasDocumentBody(anchor: string): boolean {
    const row = this.store
      .getDb()
      .prepare('SELECT 1 FROM evidence_doc_bodies WHERE doc_anchor = ? LIMIT 1')
      .get(anchor);
    return row !== undefined;
  }

  private async publishDocumentWithBody(item: EvidenceItem, bodyContent: string): Promise<void> {
    // Persist metadata with an incomplete sourceHash stamp first; commit the final sourceHash
    // only inside the same atomic SQLite transaction that replaces the lexical body row.
    // Any failure leaves source_hash NULL so the next rebuild retries and recovers cleanly.
    // Keeping external bodies in evidence_doc_bodies (rather than vector-tracked evidence_passages)
    // preserves G0/G1 passage_vectors cohort readiness with zero extra embedding batches.
    await this.store.upsert([{ ...item, sourceHash: undefined }]);
    await this.store.runExclusive(() => {
      const db = this.store.getDb();
      db.transaction(() => {
        if (bodyContent.length > 0) {
          db.prepare(
            `INSERT INTO evidence_doc_bodies (doc_anchor, content, updated_at)
             VALUES (?, ?, ?)
             ON CONFLICT(doc_anchor) DO UPDATE SET
               content = excluded.content,
               updated_at = excluded.updated_at
             WHERE evidence_doc_bodies.content IS NOT excluded.content
                OR evidence_doc_bodies.updated_at IS NOT excluded.updated_at`,
          ).run(item.anchor, bodyContent, item.updatedAt);
        } else {
          db.prepare('DELETE FROM evidence_doc_bodies WHERE doc_anchor = ?').run(item.anchor);
        }
        db.prepare('UPDATE evidence_docs SET source_hash = ? WHERE anchor = ?').run(
          item.sourceHash ?? null,
          item.anchor,
        );
      })();
    });
  }

  private async indexResults(results: ScannedEvidence[], force: boolean) {
    const now = new Date().toISOString();
    let indexed = 0;
    let skipped = 0;
    const currentAnchors = new Set<string>();
    const indexedItems: EvidenceItem[] = [];

    for (const result of results) {
      const hash = createHash('sha256').update(result.rawContent).digest('hex');
      const anchor = result.item.anchor;
      const bodyContent = this.extractLexicalBody(result);
      currentAnchors.add(anchor);

      if (!force) {
        const existing = await this.store.getByAnchor(anchor);
        const bodyReady = bodyContent.length === 0 || this.hasDocumentBody(anchor);
        if (
          existing?.sourceHash === hash &&
          existing.authority === this.manifest.reviewPolicy.authorityCeiling &&
          bodyReady
        ) {
          skipped++;
          continue;
        }
      }

      const item: EvidenceItem = {
        ...result.item,
        sourceHash: hash,
        updatedAt: now,
        authority: this.manifest.reviewPolicy.authorityCeiling,
      };
      await this.publishDocumentWithBody(item, bodyContent);
      indexedItems.push(item);
      indexed++;
    }

    await this.cleanStale(currentAnchors);
    return { indexed, skipped, indexedItems };
  }

  private async purgeCollection(): Promise<void> {
    const prefix = `${this.manifest.id}:`;
    const db = this.store.getDb();
    const rows = db.prepare('SELECT anchor FROM evidence_docs WHERE anchor LIKE ?').all(`${prefix}%`) as {
      anchor: string;
    }[];
    for (const row of rows) {
      await this.store.deleteByAnchor(row.anchor);
    }
    await this.deleteCollectionFrontmatterSupersedesEdges();
  }

  private async cleanStale(currentAnchors: Set<string>): Promise<void> {
    const prefix = `${this.manifest.id}:`;
    const db = this.store.getDb();
    const rows = db.prepare('SELECT anchor FROM evidence_docs WHERE anchor LIKE ?').all(`${prefix}%`) as {
      anchor: string;
    }[];
    for (const row of rows) {
      if (!currentAnchors.has(row.anchor)) {
        await this.store.deleteByAnchor(row.anchor);
      }
    }
  }

  private async replaceFrontmatterSupersedesEdges(results: ScannedEvidence[]): Promise<void> {
    await this.deleteCollectionFrontmatterSupersedesEdges();

    for (const result of results) {
      await this.addFrontmatterSupersedesEdges(result.item.anchor, result.rawContent);
    }
  }

  private async refreshFrontmatterSupersedesEdges(anchor: string, rawContent: string): Promise<void> {
    await this.deleteFrontmatterSupersedesEdges(anchor);
    await this.addFrontmatterSupersedesEdges(anchor, rawContent);
  }

  private async deleteCollectionFrontmatterSupersedesEdges(): Promise<void> {
    const prefix = `${this.manifest.id}:`;
    await this.store.runExclusive(() => {
      this.store
        .getDb()
        .prepare(
          "DELETE FROM edges WHERE relation = 'supersedes' AND provenance = 'frontmatter' AND from_anchor LIKE ?",
        )
        .run(`${prefix}%`);
    });
  }

  private async deleteFrontmatterSupersedesEdges(anchor: string): Promise<void> {
    await this.store.runExclusive(() => {
      this.store
        .getDb()
        .prepare("DELETE FROM edges WHERE relation = 'supersedes' AND provenance = 'frontmatter' AND from_anchor = ?")
        .run(anchor);
    });
  }

  private async addFrontmatterSupersedesEdges(fromAnchor: string, rawContent: string): Promise<void> {
    if (!rawContent) return;
    const refs = extractSupersedes(extractFrontmatter(rawContent));
    if (refs.length === 0) return;

    for (const ref of refs) {
      const toAnchor = this.collectionScopedAnchor(ref);
      if (toAnchor === fromAnchor) continue;
      await this.store.addEdge({
        fromAnchor,
        toAnchor,
        relation: 'supersedes',
        provenance: 'frontmatter',
        fromCollectionId: this.manifest.id,
        toCollectionId: this.manifest.id,
        edgeSensitivity: this.manifest.sensitivity,
      });
    }
  }

  private collectionScopedAnchor(anchor: string): string {
    const prefix = `${this.manifest.id}:`;
    return anchor.startsWith(prefix) ? anchor : `${prefix}${anchor}`;
  }
}
