import { createHash } from 'node:crypto';
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
  embedding: IEmbeddingService;
  vectorStore: VectorStore;
}

export class CollectionIndexBuilder {
  constructor(
    private readonly store: SqliteEvidenceStore,
    private readonly manifest: CollectionManifest,
    private readonly scanner: RepoScanner,
    private readonly embedDeps?: CollectionEmbedDeps,
  ) {}

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

    if (this.embedDeps && indexedItems.length > 0) {
      const { embedding, vectorStore } = this.embedDeps;
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
}
