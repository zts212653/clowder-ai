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
  rejectedAnchors?: string[];
}

export interface CollectionEmbedDeps {
  getEmbeddingService: () => IEmbeddingService | undefined;
  vectorStore: VectorStore;
}

export interface CollectionIndexBuilderOptions {
  /**
   * Opt-in lexical full-body storage (`evidence_doc_bodies` + `evidence_doc_body_fts`).
   * Defaults to `false` so non-external callers (e.g. `domain:user-profile` and direct
   * builder callers) never persist full document bodies implicitly.
   */
  storeDocumentBodies?: boolean;
}

export class CollectionSecretRejectionError extends Error {
  readonly code = 'COLLECTION_SECRET_REJECTED';

  constructor(
    readonly collectionId: string,
    readonly rejectedAnchors: string[],
    readonly secretFindings: SecretFinding[],
  ) {
    super(
      `Collection ${collectionId} incremental update rejected ${rejectedAnchors.length} document(s) by SecretScanner (${secretFindings.length} finding(s))`,
    );
    this.name = 'CollectionSecretRejectionError';
  }
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
  private readonly storeDocumentBodies: boolean;

  constructor(
    private readonly store: SqliteEvidenceStore,
    private readonly manifest: CollectionManifest,
    private readonly scanner: RepoScanner,
    private readonly embedDeps?:
      | CollectionEmbedDeps
      | (() => CollectionEmbedDeps | undefined | Promise<CollectionEmbedDeps | undefined>),
    options?: CollectionIndexBuilderOptions,
  ) {
    this.store.setSourceRoot(this.manifest.root, this.manifest.id);
    this.storeDocumentBodies = options?.storeDocumentBodies === true;
  }

  async rebuild(options?: { force?: boolean }): Promise<CollectionRebuildResult> {
    const force = options?.force ?? false;
    const results = this.scanner.discover(this.manifest.root);

    let cleanResults = results;
    const secretFindings: SecretFinding[] = [];
    const rejectedAnchors: string[] = [];

    if (this.storeDocumentBodies) {
      // External collections enforce SecretScanner per document so one rejected file never purges
      // legal sibling documents; offending anchors have their derived metadata/body/FTS/edges removed.
      // Only when every discovered document fails SecretScanner is the collection marked blocked.
      cleanResults = [];
      for (const entry of results) {
        const { findings } = SecretScanner.scanBatch([
          { path: entry.item.sourcePath ?? entry.item.anchor, content: entry.rawContent },
        ]);
        if (findings.length > 0) {
          rejectedAnchors.push(entry.item.anchor);
          secretFindings.push(...findings);
          await this.store.deleteByAnchor(entry.item.anchor);
          await this.deleteFrontmatterSupersedesEdges(entry.item.anchor);
        } else {
          cleanResults.push(entry);
        }
      }
      if (rejectedAnchors.length > 0 && cleanResults.length === 0) {
        await this.purgeCollection();
        return { indexed: 0, skipped: 0, blocked: true, secretFindings, rejectedAnchors };
      }
    } else {
      // Non-external / default generic callers retain existing collection-wide fail-closed policy (AC-C1/P1-A).
      const { findings } = SecretScanner.scanBatch(
        results.map((r) => ({ path: r.item.sourcePath ?? r.item.anchor, content: r.rawContent })),
      );
      if (findings.length > 0) {
        await this.purgeCollection();
        return { indexed: 0, skipped: 0, blocked: true, secretFindings: findings };
      }
    }

    const { indexed, skipped, indexedItems } = await this.indexResults(cleanResults, force);
    await this.replaceFrontmatterSupersedesEdges(cleanResults);

    if (this.embedDeps) {
      try {
        const deps = typeof this.embedDeps === 'function' ? await this.embedDeps() : this.embedDeps;
        if (!deps) {
          return {
            indexed,
            skipped,
            blocked: false,
            secretFindings,
            ...(rejectedAnchors.length > 0 ? { rejectedAnchors } : {}),
          };
        }
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

    return {
      indexed,
      skipped,
      blocked: false,
      secretFindings,
      ...(rejectedAnchors.length > 0 ? { rejectedAnchors } : {}),
    };
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

    // Per-document SecretScanner enforcement: rejected documents must not persist metadata,
    // bodies, FTS entries, or stale derived indexes, while sibling clean documents in the
    // collection remain intact and usable. Surface rejection via CollectionSecretRejectionError.
    const now = new Date().toISOString();
    const rejectedAnchors: string[] = [];
    const rejectedFindings: SecretFinding[] = [];
    for (const scanned of scannedEntries) {
      const { findings } = SecretScanner.scanBatch([
        { path: scanned.item.sourcePath ?? scanned.item.anchor, content: scanned.rawContent },
      ]);
      if (findings.length > 0) {
        rejectedAnchors.push(scanned.item.anchor);
        rejectedFindings.push(...findings);
        await this.store.deleteByAnchor(scanned.item.anchor);
        await this.deleteFrontmatterSupersedesEdges(scanned.item.anchor);
        continue;
      }

      const hash = createHash('sha256').update(scanned.rawContent).digest('hex');
      const item: EvidenceItem = {
        ...scanned.item,
        sourceHash: hash,
        updatedAt: now,
        authority: this.manifest.reviewPolicy.authorityCeiling,
      };
      if (this.storeDocumentBodies) {
        await this.publishDocumentWithBody(item, this.extractLexicalBody(scanned));
      } else {
        await this.store.upsert([item]);
      }
      await this.refreshFrontmatterSupersedesEdges(item.anchor, scanned.rawContent);
    }

    if (rejectedAnchors.length > 0) {
      throw new CollectionSecretRejectionError(this.manifest.id, rejectedAnchors, rejectedFindings);
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
    // Any failure rolls back the body write and leaves source_hash NULL so the next rebuild
    // retries and recovers cleanly.
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
      const bodyContent = this.storeDocumentBodies ? this.extractLexicalBody(result) : '';
      currentAnchors.add(anchor);

      if (!force) {
        const existing = await this.store.getByAnchor(anchor);
        const bodyReady = !this.storeDocumentBodies || bodyContent.length === 0 || this.hasDocumentBody(anchor);
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
      if (this.storeDocumentBodies) {
        await this.publishDocumentWithBody(item, bodyContent);
      } else {
        await this.store.upsert([item]);
      }
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
