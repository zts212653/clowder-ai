// F102: IIndexBuilder — scan docs, parse frontmatter, build/rebuild evidence index

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import type {
  ConsistencyReport,
  EvidenceItem,
  EvidenceKind,
  IEmbeddingService,
  IIndexBuilder,
  RebuildResult,
} from './interfaces.js';
import type { SqliteEvidenceStore } from './SqliteEvidenceStore.js';
import type { VectorStore } from './VectorStore.js';

const KIND_DIRS: Record<string, EvidenceKind> = {
  features: 'feature',
  decisions: 'decision',
  plans: 'plan',
  lessons: 'lesson',
};

/** Higher number = higher priority for anchor ownership */
const KIND_PRIORITY: Record<EvidenceKind, number> = {
  feature: 4,
  decision: 3,
  plan: 2,
  session: 1,
  lesson: 1,
};

export class IndexBuilder implements IIndexBuilder {
  constructor(
    private readonly store: SqliteEvidenceStore,
    private readonly docsRoot: string,
    private embedDeps?: { embedding: IEmbeddingService; vectorStore: VectorStore },
  ) {}

  setEmbedDeps(deps: { embedding: IEmbeddingService; vectorStore: VectorStore }): void {
    this.embedDeps = deps;
  }

  async rebuild(options?: { force?: boolean }): Promise<RebuildResult> {
    const start = Date.now();
    let indexed = 0;
    let skipped = 0;

    const files = this.discoverFiles();
    const currentAnchors = new Set<string>();
    const indexedItems: EvidenceItem[] = [];

    for (const file of files) {
      const parsed = this.parseFile(file.path);
      if (!parsed) {
        skipped++;
        continue;
      }

      currentAnchors.add(parsed.anchor);

      // Skip if hash unchanged (unless force)
      if (!options?.force) {
        const existing = await this.store.getByAnchor(parsed.anchor);
        if (existing?.sourceHash === parsed.sourceHash) {
          skipped++;
          continue;
        }
      }

      // Kind-priority guard: don't let lower-priority docs overwrite higher-priority ones
      // BUT: if the existing owner's source file no longer exists on disk, allow takeover
      const existing = await this.store.getByAnchor(parsed.anchor);
      if (existing) {
        const existingPriority = KIND_PRIORITY[existing.kind] ?? 0;
        const newPriority = KIND_PRIORITY[parsed.kind] ?? 0;
        const existingFileExists = existing.sourcePath ? existsSync(join(this.docsRoot, existing.sourcePath)) : false;
        if (newPriority < existingPriority && existingFileExists) {
          skipped++;
          continue;
        }
      }

      await this.store.upsert([parsed]);
      indexedItems.push(parsed);
      indexed++;
    }

    // Remove stale anchors that no longer exist on disk
    const db = this.store.getDb();
    const allAnchors = db.prepare('SELECT anchor FROM evidence_docs').all() as Array<{ anchor: string }>;
    const removedAnchors: string[] = [];
    for (const row of allAnchors) {
      if (!currentAnchors.has(row.anchor)) {
        await this.store.deleteByAnchor(row.anchor);
        this.embedDeps?.vectorStore.delete(row.anchor);
        removedAnchors.push(row.anchor);
      }
    }

    // Phase C: generate embeddings for indexed items
    await this.embedIndexedItems(indexedItems);

    return { docsIndexed: indexed, docsSkipped: skipped, durationMs: Date.now() - start };
  }

  async incrementalUpdate(changedPaths: string[]): Promise<void> {
    // Two-pass: deletions first, then upserts.
    // This ensures that when a higher-priority owner is deleted and a lower-priority
    // doc is updated in the same batch, the deletion clears the way for the upsert.
    const toUpsert: Array<{ filePath: string; parsed: EvidenceItem }> = [];
    const toDelete: string[] = [];

    for (const filePath of changedPaths) {
      const parsed = this.parseFile(filePath);
      if (parsed) {
        toUpsert.push({ filePath, parsed });
      } else {
        toDelete.push(filePath);
      }
    }

    // Pass 1: deletions (P1: sync vector deletion) + backfill from candidate docs
    const deletedAnchors: string[] = [];
    for (const filePath of toDelete) {
      const relPath = relative(this.docsRoot, filePath);
      const db = this.store.getDb();
      const row = db.prepare('SELECT anchor FROM evidence_docs WHERE source_path = ?').get(relPath) as
        | { anchor: string }
        | undefined;
      if (row) {
        await this.store.deleteByAnchor(row.anchor);
        this.embedDeps?.vectorStore.delete(row.anchor);
        deletedAnchors.push(row.anchor);
      }
    }

    // Backfill: for each deleted anchor, scan for remaining docs that claim it
    if (deletedAnchors.length > 0) {
      const allFiles = this.discoverFiles();
      for (const anchor of deletedAnchors) {
        const candidates = allFiles
          .map((f) => this.parseFile(f.path))
          .filter((p): p is EvidenceItem => p !== null && p.anchor === anchor);
        if (candidates.length > 0) {
          // Pick highest-priority candidate
          candidates.sort((a, b) => (KIND_PRIORITY[b.kind] ?? 0) - (KIND_PRIORITY[a.kind] ?? 0));
          const best = candidates[0]!;
          // Only backfill if not already queued for upsert
          if (!toUpsert.some((u) => u.parsed.anchor === anchor)) {
            toUpsert.push({ filePath: join(this.docsRoot, best.sourcePath!), parsed: best });
          }
        }
      }
    }

    // Pass 2: upserts (with kind-priority guard) + embed new/changed docs
    for (const { parsed } of toUpsert) {
      const existing = await this.store.getByAnchor(parsed.anchor);
      if (existing) {
        const existingPriority = KIND_PRIORITY[existing.kind] ?? 0;
        const newPriority = KIND_PRIORITY[parsed.kind] ?? 0;
        if (newPriority < existingPriority) {
          continue;
        }
      }
      await this.store.upsert([parsed]);
      // Embed the new/changed doc
      if (this.embedDeps?.embedding.isReady()) {
        try {
          const [vec] = await this.embedDeps.embedding.embed([`${parsed.title} ${parsed.summary ?? ''}`]);
          this.embedDeps.vectorStore.upsert(parsed.anchor, vec);
        } catch {
          // fail-open: skip embedding on error
        }
      }
    }
  }

  async checkConsistency(): Promise<ConsistencyReport> {
    const db = this.store.getDb();
    const docCount = (db.prepare('SELECT count(*) AS c FROM evidence_docs').get() as { c: number }).c;
    const ftsCount = (db.prepare('SELECT count(*) AS c FROM evidence_fts').get() as { c: number }).c;

    return {
      ok: docCount === ftsCount,
      docCount,
      ftsCount,
      mismatches: docCount !== ftsCount ? [`doc=${docCount} fts=${ftsCount}`] : [],
    };
  }

  // ── Private ──────────────────────────────────────────────────────

  /**
   * Batch-embed indexed items when embedding service is ready.
   * AC-C6: check meta consistency — if model changed, clearAll + re-embed all docs.
   */
  private async embedIndexedItems(items: EvidenceItem[]): Promise<void> {
    if (!this.embedDeps?.embedding.isReady() || items.length === 0) return;

    const { embedding, vectorStore } = this.embedDeps;

    // Version anchor check: model/dim change → full re-embed
    const consistency = vectorStore.checkMetaConsistency(embedding.getModelInfo());
    let itemsToEmbed = items;
    if (!consistency.consistent) {
      vectorStore.clearAll();
      // Re-embed ALL docs in store, not just newly indexed ones
      const db = this.store.getDb();
      const allDocs = db.prepare('SELECT anchor, title, summary FROM evidence_docs').all() as Array<{
        anchor: string;
        title: string;
        summary: string | null;
      }>;
      itemsToEmbed = allDocs.map(
        (d) => ({ anchor: d.anchor, title: d.title, summary: d.summary ?? undefined }) as EvidenceItem,
      );
    }

    try {
      const texts = itemsToEmbed.map((i) => `${i.title} ${i.summary ?? ''}`);
      const vectors = await embedding.embed(texts);
      for (let i = 0; i < itemsToEmbed.length; i++) {
        vectorStore.upsert(itemsToEmbed[i].anchor, vectors[i]);
      }
      vectorStore.initMeta(embedding.getModelInfo());
    } catch {
      // fail-open: embedding errors don't block indexing
    }
  }

  private discoverFiles(): Array<{ path: string; kind: EvidenceKind }> {
    const results: Array<{ path: string; kind: EvidenceKind }> = [];

    for (const [dir, kind] of Object.entries(KIND_DIRS)) {
      const dirPath = join(this.docsRoot, dir);
      try {
        const entries = readdirSync(dirPath);
        for (const entry of entries) {
          if (!entry.endsWith('.md')) continue;
          const fullPath = join(dirPath, entry);
          if (statSync(fullPath).isFile()) {
            results.push({ path: fullPath, kind });
          }
        }
      } catch {
        // Directory doesn't exist — skip
      }
    }

    return results;
  }

  private parseFile(filePath: string): EvidenceItem | null {
    let content: string;
    try {
      content = readFileSync(filePath, 'utf-8');
    } catch {
      return null;
    }

    const frontmatter = extractFrontmatter(content);
    if (!frontmatter) return null;

    const anchor = extractAnchor(frontmatter);
    if (!anchor) return null;

    const kind = inferKind(frontmatter, filePath);
    const title = extractTitle(content);
    const summary = extractSummary(content);
    const sourceHash = createHash('sha256').update(content).digest('hex').slice(0, 16);

    const status = (typeof frontmatter.status === 'string' ? frontmatter.status : 'active') as EvidenceItem['status'];

    const item: EvidenceItem = {
      anchor,
      kind,
      status,
      title: title ?? anchor,
      updatedAt: new Date().toISOString(),
      sourcePath: relative(this.docsRoot, filePath),
    };
    if (summary) item.summary = summary;
    const topics = frontmatter.topics;
    if (Array.isArray(topics)) item.keywords = topics as string[];
    item.sourceHash = sourceHash;

    return item;
  }
}

// ── Frontmatter parsing ──────────────────────────────────────────────

function extractFrontmatter(content: string): Record<string, unknown> | null {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match?.[1]) return null;

  const yaml = match[1];
  const result: Record<string, unknown> = {};

  for (const line of yaml.split('\n')) {
    const kv = line.match(/^(\w+):\s*(.+)$/);
    if (!kv) continue;
    const key = kv[1]!;
    const rawVal = kv[2]!;
    // Parse simple arrays: [a, b, c]
    const arrMatch = rawVal.match(/^\[(.+)]$/);
    if (arrMatch) {
      result[key] = arrMatch[1]?.split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, ''));
    } else {
      result[key] = rawVal.trim();
    }
  }

  return Object.keys(result).length > 0 ? result : null;
}

function extractAnchor(fm: Record<string, unknown>): string | null {
  // Direct anchor field (from MaterializationService or explicit frontmatter)
  const anchor = fm.anchor;
  if (typeof anchor === 'string') return anchor;
  // feature_ids: [F042] → F042
  const featureIds = fm.feature_ids;
  if (Array.isArray(featureIds) && featureIds.length > 0) {
    return featureIds[0] as string;
  }
  // decision_id: ADR-005
  const decisionId = fm.decision_id;
  if (typeof decisionId === 'string') return decisionId;
  // plan_id: PLAN-001
  const planId = fm.plan_id;
  if (typeof planId === 'string') return planId;
  return null;
}

function inferKind(fm: Record<string, unknown>, filePath: string): EvidenceKind {
  const docKind = fm.doc_kind;
  if (docKind === 'decision' || filePath.includes('/decisions/')) return 'decision';
  if (docKind === 'plan' || filePath.includes('/plans/')) return 'plan';
  if (docKind === 'lesson') return 'lesson';
  return 'feature';
}

function extractTitle(content: string): string | null {
  // First # heading after frontmatter
  const match = content.match(/^#\s+(.+)$/m);
  return match?.[1]?.trim() ?? null;
}

function extractSummary(content: string): string | null {
  // First non-empty paragraph after the title
  const afterTitle = content.replace(/^---[\s\S]*?---\s*/, '').replace(/^#.*$/m, '');
  const paragraphs = afterTitle.split(/\n\n+/).filter((p) => p.trim() && !p.startsWith('#'));
  const first = paragraphs[0];
  if (!first) return null;
  const trimmed = first.trim().replace(/\n/g, ' ');
  return trimmed.length > 300 ? `${trimmed.slice(0, 297)}...` : trimmed;
}
