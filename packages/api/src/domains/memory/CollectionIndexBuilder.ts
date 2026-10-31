import { createHash } from 'node:crypto';
import { extractFrontmatter, extractSupersedes } from './CatCafeScanner.js';
import type { CollectionManifest } from './collection-types.js';
import { embedIndexedItems } from './embed-utils.js';
import type { EvidenceItem, IEmbeddingService, RepoScanner, ScannedEvidence } from './interfaces.js';
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
    private readonly embedDeps?: CollectionEmbedDeps,
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

    if (this.embedDeps && indexedItems.length > 0) {
      const { getEmbeddingService, vectorStore } = this.embedDeps;
      const embedding = createLiveEmbeddingCapability(getEmbeddingService);
      const store = this.store;
      try {
        await embedIndexedItems({
          items: indexedItems,
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
    const now = new Date().toISOString();
    for (const filePath of changedPaths) {
      if (!('parseSingle' in this.scanner && typeof this.scanner.parseSingle === 'function')) continue;
      const scanned = (this.scanner as { parseSingle(f: string, r: string): ScannedEvidence | null }).parseSingle(
        filePath,
        this.manifest.root,
      );
      if (!scanned) continue;
      const hash = createHash('sha256').update(scanned.rawContent).digest('hex');
      const item: EvidenceItem = {
        ...scanned.item,
        sourceHash: hash,
        updatedAt: now,
        authority: this.manifest.reviewPolicy.authorityCeiling,
      };
      await this.store.upsert([item]);
      await this.refreshFrontmatterSupersedesEdges(item.anchor, scanned.rawContent);
    }
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
      currentAnchors.add(anchor);

      if (!force) {
        const existing = await this.store.getByAnchor(anchor);
        if (existing?.sourceHash === hash && existing.authority === this.manifest.reviewPolicy.authorityCeiling) {
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
      await this.store.upsert([item]);
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
