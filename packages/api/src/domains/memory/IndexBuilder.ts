// F102: IIndexBuilder — scan docs, parse frontmatter, build/rebuild evidence index
// F152 Phase A: refactored to use RepoScanner strategy (KD-5)

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { CatCafeScanner, extractAnchor, extractFrontmatter } from './CatCafeScanner.js';
import { GenericRepoScanner } from './GenericRepoScanner.js';
import type {
  ConsistencyReport,
  EvidenceItem,
  EvidenceKind,
  IEmbeddingService,
  IIndexBuilder,
  RebuildResult,
  RepoScanner,
} from './interfaces.js';

// Re-export for backward compatibility — external code imports KIND_DIRS from IndexBuilder
export { KIND_DIRS } from './CatCafeScanner.js';

import type { SqliteEvidenceStore } from './SqliteEvidenceStore.js';
import { SIGNAL_FLAGS } from './summary-config.js';
import type { VectorStore } from './VectorStore.js';

/**
 * Bump when scanner extraction logic changes (e.g., new fields derived from
 * the same source files). A version mismatch triggers an automatic full
 * re-index on the next rebuild(), so users only need to restart the API.
 *
 * History:
 *   1 — initial (implicit, pre-versioning)
 *   2 — CatCafeScanner: section headings → keywords (PR #1179)
 *   3 — Phase D: pathToAuthority backfill (authority derived from path)
 */
export const INDEXING_VERSION = 3;

/** Higher number = higher priority for anchor ownership */
const KIND_PRIORITY: Record<EvidenceKind, number> = {
  feature: 4,
  decision: 3,
  plan: 2,
  discussion: 2,
  research: 2,
  session: 1,
  lesson: 1,
  thread: 1,
  'pack-knowledge': 0, // F129: pack knowledge — lowest priority, never overwrites global docs
};

/**
 * Minimal thread snapshot for indexing — avoids coupling to full IThreadStore interface.
 * The caller (factory/index.ts) provides a callback that returns these.
 */
export interface ThreadSnapshot {
  id: string;
  title: string | null;
  participants: string[];
  threadMemory?: { summary: string } | null;
  lastActiveAt: number;
  /** Feature IDs associated with this thread (from phase, backlogItemId, etc.) */
  featureIds?: string[];
}

/** Callback that returns all threads for indexing. */
export type ThreadListFn = () => ThreadSnapshot[] | Promise<ThreadSnapshot[]>;

/** Callback that returns thread IDs to exclude from session digest indexing. */
export type ExcludeThreadIdsFn = () => Set<string> | Promise<Set<string>>;

/** Snapshot of a single message for passage indexing. */
export interface StoredMessageSnapshot {
  id: string;
  content: string;
  catId?: string;
  threadId: string;
  timestamp: number;
}

/** Callback that returns messages for a given thread. */
export type MessageListFn = (
  threadId: string,
  limit?: number,
) => StoredMessageSnapshot[] | Promise<StoredMessageSnapshot[]>;

const PROJECT_MANIFESTS = [
  'package.json',
  'Cargo.toml',
  'go.mod',
  'pyproject.toml',
  'pom.xml',
  'build.gradle',
  'Gemfile',
  'composer.json',
  'pubspec.yaml',
];

function hasProjectManifest(dir: string): boolean {
  return PROJECT_MANIFESTS.some((f) => existsSync(join(dir, f)));
}

/** AC-A3: auto-select scanner + resolve the correct scan root (P1-1 fix) */
function detectScanner(docsRoot: string): { scanner: RepoScanner; scanRoot: string } {
  // Cat-café repos have features/ or decisions/ inside docsRoot
  if (existsSync(join(docsRoot, 'features')) || existsSync(join(docsRoot, 'decisions'))) {
    return { scanner: new CatCafeScanner(), scanRoot: docsRoot };
  }
  // docsRoot itself might be a project root (has manifests directly)
  if (hasProjectManifest(docsRoot)) {
    return { scanner: new GenericRepoScanner(), scanRoot: docsRoot };
  }
  // Production path: docsRoot is a docs/ subdirectory — check parent for manifests
  const parentDir = resolve(docsRoot, '..');
  if (parentDir !== resolve(docsRoot) && hasProjectManifest(parentDir)) {
    return { scanner: new GenericRepoScanner(), scanRoot: parentDir };
  }
  // Default: CatCafeScanner (backward compatible)
  return { scanner: new CatCafeScanner(), scanRoot: docsRoot };
}

export class IndexBuilder implements IIndexBuilder {
  /** E-2: Set of threadIds that have been modified since last flush */
  private dirtyThreads = new Set<string>();

  /** F152 Phase A: pluggable scanner — defaults to CatCafeScanner */
  private readonly scanner: RepoScanner & {
    parseSingle?(f: string, r: string): import('./interfaces.js').ScannedEvidence | null;
  };

  /** F152 P1-1 fix: the root directory the scanner should scan (may differ from docsRoot) */
  private readonly scanRoot: string;

  constructor(
    private readonly store: SqliteEvidenceStore,
    private readonly docsRoot: string,
    private embedDeps?: { embedding: IEmbeddingService; vectorStore: VectorStore },
    private readonly transcriptDataDir?: string,
    private readonly threadListFn?: ThreadListFn,
    private readonly messageListFn?: MessageListFn,
    private readonly excludeThreadIdsFn?: ExcludeThreadIdsFn,
    scanner?: RepoScanner,
  ) {
    if (scanner) {
      this.scanner = scanner;
      this.scanRoot = docsRoot;
    } else {
      const detected = detectScanner(docsRoot);
      this.scanner = detected.scanner;
      this.scanRoot = detected.scanRoot;
    }
  }

  setEmbedDeps(deps: { embedding: IEmbeddingService; vectorStore: VectorStore }): void {
    this.embedDeps = deps;
  }

  /** P2-4 fix: auto-skip soft clues for large repos (AC-A5 performance guard) */
  private buildScanOptions(): Record<string, unknown> {
    if (!(this.scanner instanceof GenericRepoScanner)) return {};
    try {
      const entryCount = readdirSync(this.scanRoot).length;
      return entryCount > 200 ? { skipSoftClues: true } : {};
    } catch {
      return {};
    }
  }

  /** Returns true when scanner logic has changed since last index build. */
  private hasIndexingVersionChanged(): boolean {
    try {
      const db = this.store.getDb();
      const row = db.prepare("SELECT value FROM embedding_meta WHERE key = 'indexing_version'").get() as
        | { value: string }
        | undefined;
      return row?.value !== String(INDEXING_VERSION);
    } catch {
      return true; // table missing or error → treat as version mismatch
    }
  }

  private async storeIndexingVersion(): Promise<void> {
    try {
      await this.store.runExclusive(() => {
        const db = this.store.getDb();
        db.prepare("INSERT OR REPLACE INTO embedding_meta (key, value) VALUES ('indexing_version', ?)").run(
          String(INDEXING_VERSION),
        );
      });
    } catch {
      // fail-open: version not persisted → next restart will re-index (safe)
    }
  }

  async rebuild(options?: { force?: boolean }): Promise<RebuildResult> {
    const start = Date.now();
    let indexed = 0;
    let skipped = 0;

    // Auto-force when scanner logic has changed since last rebuild
    const versionChanged = this.hasIndexingVersionChanged();
    const effectiveForce = options?.force || versionChanged;

    // F152 Phase A: delegate to pluggable scanner (KD-5)
    const scannedItems = this.scanner.discover(this.scanRoot, this.buildScanOptions());
    const currentAnchors = new Set<string>();
    const indexedItems: EvidenceItem[] = [];

    for (const scanned of scannedItems) {
      const sourceHash = scanned.rawContent
        ? createHash('sha256').update(scanned.rawContent).digest('hex').slice(0, 16)
        : ((scanned.item as EvidenceItem).sourceHash ??
          createHash('sha256').update(scanned.item.title).digest('hex').slice(0, 16));

      const item: EvidenceItem = {
        ...scanned.item,
        sourceHash,
        provenance: scanned.provenance,
      };

      currentAnchors.add(item.anchor);

      // Skip if hash unchanged AND provenance already populated (unless force/version bump)
      // P1-2 fix: don't skip when existing doc lacks provenance but new scan provides it
      if (!effectiveForce) {
        const existing = await this.store.getByAnchor(item.anchor);
        if (existing?.sourceHash === item.sourceHash) {
          const needsProvenanceBackfill = !existing?.provenance?.tier && item.provenance?.tier;
          if (!needsProvenanceBackfill) {
            skipped++;
            continue;
          }
        }
      }

      // Kind-priority guard: don't let lower-priority docs overwrite higher-priority ones
      const existing = await this.store.getByAnchor(item.anchor);
      if (existing) {
        const existingPriority = KIND_PRIORITY[existing.kind] ?? 0;
        const newPriority = KIND_PRIORITY[item.kind] ?? 0;
        const existingFileExists = existing.sourcePath ? existsSync(join(this.docsRoot, existing.sourcePath)) : false;
        if (newPriority < existingPriority && existingFileExists) {
          skipped++;
          continue;
        }
      }

      await this.store.upsert([item]);
      indexedItems.push(item);
      indexed++;
    }

    // Phase D: auto-extract edges from frontmatter cross-references (AC-D18, KD-29)
    await this.store.runExclusive(() => {
      this.store.getDb().prepare("DELETE FROM edges WHERE relation = 'related'").run();
    });

    for (const scanned of scannedItems) {
      if (!scanned.rawContent) continue;
      const fm = extractFrontmatter(scanned.rawContent);
      if (!fm) continue;
      const anchor = extractAnchor(fm);
      if (!anchor) continue;

      const relatedFeatures = fm.related_features;
      if (Array.isArray(relatedFeatures)) {
        for (const ref of relatedFeatures) {
          if (typeof ref === 'string' && ref !== anchor) {
            await this.store.addEdge({ fromAnchor: anchor, toAnchor: ref, relation: 'related' });
          }
        }
      }
    }

    // Phase D-6: Index session digests (kind=session)
    if (this.transcriptDataDir) {
      const excludedThreadIds = this.excludeThreadIdsFn ? await this.excludeThreadIdsFn() : undefined;
      const sessionItems = this.discoverSessionDigests(excludedThreadIds);
      for (const item of sessionItems) {
        currentAnchors.add(item.anchor);
        if (!options?.force) {
          const existing = await this.store.getByAnchor(item.anchor);
          if (existing?.sourceHash === item.sourceHash) {
            skipped++;
            continue;
          }
        }
        await this.store.upsert([item]);
        indexedItems.push(item);
        indexed++;
      }
    }

    // Phase E-1: Index thread summaries
    let threadListFailed = false;
    if (this.threadListFn) {
      let threads: ThreadSnapshot[];
      try {
        threads = await this.threadListFn();
      } catch {
        threads = [];
        threadListFailed = true;
      }

      for (const thread of threads) {
        const anchor = `thread-${thread.id}`;
        const title = thread.title ?? `Thread ${thread.id.slice(0, 12)}`;
        const keywords = [...thread.participants, ...(thread.featureIds ?? [])];

        // KD-32/33: Build summary from message content, not threadMemory.summary
        // threadMemory.summary is empty for 96% of threads — useless as data source
        let summary = '';
        if (this.messageListFn) {
          try {
            const messages = await this.messageListFn(thread.id, 100);
            if (messages.length > 0) {
              const turns = messages.map((m) => `[${m.catId ?? 'user'}] ${m.content}`);
              // Truncate to ~3000 chars for FTS5 summary field
              const joined = turns.join('\n');
              summary = joined.length > 3000 ? `${joined.slice(0, 2997)}...` : joined;
            }
          } catch {
            // fail-open: skip this thread's messages
          }
        }
        // Fallback: use threadMemory.summary if messages unavailable
        if (!summary) {
          summary = thread.threadMemory?.summary ?? '';
        }
        // Still nothing? Use title as minimal searchable content
        if (!summary) {
          summary = title;
        }

        const sourceHash = createHash('sha256').update(summary).digest('hex').slice(0, 16);

        currentAnchors.add(anchor);
        if (!options?.force) {
          const existing = await this.store.getByAnchor(anchor);
          if (existing?.sourceHash === sourceHash) {
            skipped++;
            continue;
          }
        }
        const item: EvidenceItem = {
          anchor,
          kind: 'thread',
          status: 'active',
          title,
          summary,
          keywords: keywords.length > 0 ? keywords : undefined,
          sourcePath: `threads/${thread.id}`,
          sourceHash,
          updatedAt: new Date(thread.lastActiveAt).toISOString(),
        };
        await this.store.upsert([item]);
        indexedItems.push(item);
        indexed++;
      }
    }

    // Phase E-3: Index thread message passages
    let threads: ThreadSnapshot[] = [];
    if (this.messageListFn && this.threadListFn && !threadListFailed) {
      try {
        threads = await this.threadListFn();
      } catch {
        threads = [];
      }
      await this.indexPassages(threads);
    }

    // Phase I (AC-I1/I3): Backfill from JSONL transcripts for threads with expired Redis messages
    if (this.transcriptDataDir && threads.length > 0) {
      for (const thread of threads) {
        await this.backfillPassagesFromTranscript(thread.id);
      }
    }

    // Remove stale anchors that no longer exist on disk
    // P1 fix: if threadListFn failed, preserve existing thread-* anchors (don't delete on transient error)
    const db = this.store.getDb();
    const allAnchors = db.prepare('SELECT anchor FROM evidence_docs').all() as Array<{ anchor: string }>;
    const removedAnchors: string[] = [];
    for (const row of allAnchors) {
      if (!currentAnchors.has(row.anchor)) {
        if (threadListFailed && row.anchor.startsWith('thread-')) continue;
        await this.store.deleteByAnchor(row.anchor);
        this.embedDeps?.vectorStore.delete(row.anchor);
        removedAnchors.push(row.anchor);
      }
    }

    // Phase C: generate embeddings for indexed items
    await this.embedIndexedItems(indexedItems);

    // Persist current indexing version so next startup can detect changes
    await this.storeIndexingVersion();

    return { docsIndexed: indexed, docsSkipped: skipped, durationMs: Date.now() - start };
  }

  async incrementalUpdate(changedPaths: string[]): Promise<void> {
    // Two-pass: deletions first, then upserts.
    // This ensures that when a higher-priority owner is deleted and a lower-priority
    // doc is updated in the same batch, the deletion clears the way for the upsert.
    const toUpsert: Array<{ filePath: string; parsed: EvidenceItem }> = [];
    const toDelete: string[] = [];

    for (const filePath of changedPaths) {
      const parsed = this.parseSingleFile(filePath);
      if (parsed) {
        toUpsert.push({ filePath, parsed });
      } else {
        toDelete.push(filePath);
      }
    }

    // Pass 1: deletions (P1: sync vector deletion) + backfill from candidate docs
    const deletedAnchors: string[] = [];
    for (const filePath of toDelete) {
      // P1-5 fix: use scanRoot (not docsRoot) — source_path stored relative to scanRoot
      const relPath = relative(this.scanRoot, filePath);
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
      const allScanned = this.scanner.discover(this.scanRoot, this.buildScanOptions());
      for (const anchor of deletedAnchors) {
        const candidates = allScanned
          .filter((s) => s.item.anchor === anchor)
          .map(
            (s) =>
              ({
                ...s.item,
                sourceHash: s.rawContent
                  ? createHash('sha256').update(s.rawContent).digest('hex').slice(0, 16)
                  : undefined,
                provenance: s.provenance,
              }) as EvidenceItem,
          );
        if (candidates.length > 0) {
          candidates.sort((a, b) => (KIND_PRIORITY[b.kind] ?? 0) - (KIND_PRIORITY[a.kind] ?? 0));
          const best = candidates[0]!;
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

  /** F152: Bridge — delegate single-file parsing to scanner (for incrementalUpdate) */
  private parseSingleFile(filePath: string): EvidenceItem | null {
    if ('parseSingle' in this.scanner && typeof this.scanner.parseSingle === 'function') {
      const scanned = this.scanner.parseSingle(filePath, this.scanRoot);
      if (!scanned) return null;
      const sourceHash = scanned.rawContent
        ? createHash('sha256').update(scanned.rawContent).digest('hex').slice(0, 16)
        : undefined;
      return { ...scanned.item, sourceHash, provenance: scanned.provenance };
    }
    return null;
  }

  /**
   * D6: Discover sealed session digests from transcript data directory.
   * Scans dataDir/threads/{threadId}/{catId}/sessions/{sessionId}/digest.extractive.json
   */
  private discoverSessionDigests(excludedThreadIds?: Set<string>): EvidenceItem[] {
    if (!this.transcriptDataDir) return [];
    const results: EvidenceItem[] = [];
    const threadsDir = join(this.transcriptDataDir, 'threads');

    let threadIds: string[];
    try {
      threadIds = readdirSync(threadsDir).filter((e) => {
        try {
          return statSync(join(threadsDir, e)).isDirectory();
        } catch {
          return false;
        }
      });
    } catch {
      return results;
    }

    for (const threadId of threadIds) {
      if (excludedThreadIds?.has(threadId)) continue;
      const threadPath = join(threadsDir, threadId);
      let catIds: string[];
      try {
        catIds = readdirSync(threadPath).filter((e) => {
          try {
            return statSync(join(threadPath, e)).isDirectory();
          } catch {
            return false;
          }
        });
      } catch {
        continue;
      }

      for (const catId of catIds) {
        const sessionsPath = join(threadPath, catId, 'sessions');
        let sessionIds: string[];
        try {
          sessionIds = readdirSync(sessionsPath).filter((e) => {
            try {
              return statSync(join(sessionsPath, e)).isDirectory();
            } catch {
              return false;
            }
          });
        } catch {
          continue;
        }

        for (const sessionId of sessionIds) {
          const digestPath = join(sessionsPath, sessionId, 'digest.extractive.json');
          try {
            const raw = readFileSync(digestPath, 'utf-8');
            const digest = JSON.parse(raw) as {
              sessionId: string;
              threadId: string;
              catId: string;
              seq: number;
              time: { createdAt: number; sealedAt: number };
              invocations?: Array<{ toolNames?: string[] }>;
              filesTouched?: Array<{ path: string }>;
            };

            const toolNames = (digest.invocations ?? [])
              .flatMap((inv) => inv.toolNames ?? [])
              .filter((v, i, a) => a.indexOf(v) === i);
            const files = (digest.filesTouched ?? []).map((f) => f.path);
            const summary = [
              `Session ${digest.seq} by ${digest.catId}`,
              toolNames.length > 0 ? `Tools: ${toolNames.join(', ')}` : '',
              files.length > 0
                ? `Files: ${files.slice(0, 5).join(', ')}${files.length > 5 ? ` (+${files.length - 5})` : ''}`
                : '',
            ]
              .filter(Boolean)
              .join('. ');

            const sourceHash = createHash('sha256').update(raw).digest('hex').slice(0, 16);
            const anchor = `session-${sessionId}`;

            results.push({
              anchor,
              kind: 'session',
              status: 'active',
              title: `Session ${digest.seq} — ${digest.catId} @ ${threadId.slice(0, 12)}`,
              summary,
              keywords: toolNames,
              sourcePath: `transcripts/threads/${threadId}/${catId}/sessions/${sessionId}`,
              sourceHash,
              updatedAt: new Date(digest.time.sealedAt).toISOString(),
            });
          } catch {
            // digest doesn't exist or parse error — skip
          }
        }
      }
    }

    return results;
  }

  // ── E-2: Dirty-thread debounce infrastructure ──────────────────────

  /** Mark a thread as dirty (its summary has changed). Called externally after messageStore.append. */
  markThreadDirty(threadId: string): void {
    this.dirtyThreads.add(threadId);
  }

  /**
   * G-3c: Accumulate pending delta into summary_state.
   * Called at append time with actual new message content (not rebuilt summary).
   * P1 fix (砚砚 review): accumulate from delta, not from flushed summary snapshot.
   */
  accumulateSummaryDelta(threadId: string, messageContent: string): void {
    const tokenEstimate = Math.ceil(messageContent.length / 4);

    let signalFlags = 0;
    const lower = messageContent.toLowerCase();
    if (/(?:决定|agreed|kd-|decided|confirmed)/i.test(lower)) signalFlags |= SIGNAL_FLAGS.DECISION;
    if (/(?:\.ts|\.js|\.tsx|pr\s*#|commit|merge|diff)/i.test(lower)) signalFlags |= SIGNAL_FLAGS.CODE;
    if (/(?:fix|bug|error|修复|报错)/i.test(lower)) signalFlags |= SIGNAL_FLAGS.ERROR_FIX;

    // Fire-and-forget through write queue (F163 AC-A5 single-writer contract)
    void this.store
      .runExclusive(() => {
        const db = this.store.getDb();
        db.prepare(`
        INSERT INTO summary_state (thread_id, pending_message_count, pending_token_count, pending_signal_flags, summary_type)
        VALUES (?, 1, ?, ?, 'concat')
        ON CONFLICT(thread_id) DO UPDATE SET
          pending_message_count = pending_message_count + 1,
          pending_token_count = pending_token_count + ?,
          pending_signal_flags = pending_signal_flags | ?
      `).run(threadId, tokenEstimate, signalFlags, tokenEstimate, signalFlags);
      })
      .catch(() => {
        /* fail-open */
      });
  }

  /** Flush dirty threads: re-index only the threads that have been marked dirty. */
  async flushDirtyThreads(): Promise<number> {
    if (this.dirtyThreads.size === 0 || !this.threadListFn) return 0;

    const dirtyIds = [...this.dirtyThreads];
    this.dirtyThreads.clear();

    let flushed = 0;
    let threads: ThreadSnapshot[];
    try {
      threads = await this.threadListFn();
    } catch {
      return 0;
    }

    const threadMap = new Map(threads.map((t) => [t.id, t]));

    for (const threadId of dirtyIds) {
      const thread = threadMap.get(threadId);
      if (!thread) continue;

      const anchor = `thread-${threadId}`;
      const title = thread.title ?? `Thread ${threadId.slice(0, 12)}`;
      const keywords = [...thread.participants, ...(thread.featureIds ?? [])];

      // KD-32/33: Build summary from message content, same logic as rebuild()
      let summary = '';
      if (this.messageListFn) {
        try {
          const messages = await this.messageListFn(threadId, 100);
          if (messages.length > 0) {
            const turns = messages.map((m) => `[${m.catId ?? 'user'}] ${m.content}`);
            const joined = turns.join('\n');
            summary = joined.length > 3000 ? `${joined.slice(0, 2997)}...` : joined;
          }
        } catch {
          // fail-open
        }
      }
      if (!summary) {
        summary = thread.threadMemory?.summary ?? '';
      }
      if (!summary) {
        summary = title;
      }

      const sourceHash = createHash('sha256').update(summary).digest('hex').slice(0, 16);

      const existing = await this.store.getByAnchor(anchor);
      if (existing?.sourceHash === sourceHash) continue; // unchanged

      const item: EvidenceItem = {
        anchor,
        kind: 'thread',
        status: 'active',
        title,
        summary,
        keywords: keywords.length > 0 ? keywords : undefined,
        sourcePath: `threads/${threadId}`,
        sourceHash,
        updatedAt: new Date(thread.lastActiveAt).toISOString(),
      };

      await this.store.upsert([item]);

      // Embed if available
      if (this.embedDeps?.embedding.isReady()) {
        try {
          const [vec] = await this.embedDeps.embedding.embed([`${title} ${summary}`]);
          this.embedDeps.vectorStore.upsert(anchor, vec);
        } catch {
          // fail-open
        }
      }

      flushed++;
    }

    return flushed;
  }

  /**
   * E-3: Index thread messages as passages in evidence_passages table.
   * For each thread, fetches messages via messageListFn and upserts into evidence_passages.
   */
  private async indexPassages(threads: ThreadSnapshot[]): Promise<void> {
    if (!this.messageListFn) return;
    const db = this.store.getDb();

    // Phase I (AC-I2): INSERT OR IGNORE — passages only increase, never deleted on rebuild.
    // Previously used DELETE-then-INSERT which lost passages when Redis messages expired.
    const upsertStmt = db.prepare(`
      INSERT OR IGNORE INTO evidence_passages
      (doc_anchor, passage_id, content, speaker, position, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    for (const thread of threads) {
      let messages: StoredMessageSnapshot[];
      try {
        messages = await this.messageListFn(thread.id, 2000);
      } catch {
        continue;
      }

      const tx = db.transaction((msgs: StoredMessageSnapshot[]) => {
        for (let i = 0; i < msgs.length; i++) {
          const msg = msgs[i];
          upsertStmt.run(
            `thread-${thread.id}`,
            `msg-${msg.id}`,
            msg.content,
            msg.catId ?? 'user',
            i,
            new Date(msg.timestamp).toISOString(),
          );
        }
      });

      // Route batch insert through single-writer queue (F163 AC-A5)
      await this.store.runExclusive(() => tx(messages));
    }
  }

  /**
   * Phase I (AC-I1): Backfill passages from JSONL transcript events.
   * Reads events.jsonl files, aggregates text chunks per invocationId,
   * and inserts as passages with INSERT OR IGNORE (idempotent).
   * Returns count of newly added passages.
   */
  async backfillPassagesFromTranscript(threadId: string): Promise<number> {
    if (!this.transcriptDataDir) return 0;
    const db = this.store.getDb();
    const threadDir = join(this.transcriptDataDir, 'threads', threadId);

    let catDirs: string[];
    try {
      catDirs = readdirSync(threadDir).filter((e) => !e.startsWith('.'));
    } catch {
      return 0;
    }

    const insertStmt = db.prepare(`
      INSERT OR IGNORE INTO evidence_passages
      (doc_anchor, passage_id, content, speaker, position, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    let added = 0;
    let position = 10000; // offset to avoid collision with Redis-sourced positions (0-based)

    for (const catId of catDirs) {
      const sessionsDir = join(threadDir, catId, 'sessions');
      let sessionDirs: string[];
      try {
        sessionDirs = readdirSync(sessionsDir).filter((e) => !e.startsWith('.'));
      } catch {
        continue;
      }

      for (const sessionId of sessionDirs) {
        const eventsPath = join(sessionsDir, sessionId, 'events.jsonl');
        let content: string;
        try {
          content = readFileSync(eventsPath, 'utf-8');
        } catch {
          continue;
        }

        // Accumulate text chunks by invocationId
        const invocationTexts = new Map<string, { text: string; t: number; catId: string }>();

        for (const line of content.split('\n')) {
          if (!line.trim()) continue;
          try {
            const evt = JSON.parse(line);
            if (evt.event?.type === 'text' && typeof evt.event?.content === 'string') {
              const invId = evt.invocationId ?? `${sessionId}-noninv`;
              const existing = invocationTexts.get(invId);
              if (existing) {
                existing.text += evt.event.content;
              } else {
                invocationTexts.set(invId, {
                  text: evt.event.content,
                  catId: evt.catId ?? catId,
                  t: evt.t,
                });
              }
            }
          } catch {
            /* skip malformed lines */
          }
        }

        // Insert accumulated text per invocation — routed through single-writer queue (F163 AC-A5)
        const tx = db.transaction(() => {
          for (const [invId, data] of invocationTexts) {
            if (!data.text.trim()) continue;
            // Guard: skip entries with missing/invalid timestamp (P1 fix)
            const ts = new Date(data.t);
            if (Number.isNaN(ts.getTime())) continue;
            const result = insertStmt.run(
              `thread-${threadId}`,
              `transcript-${invId}`,
              data.text,
              data.catId,
              position++,
              ts.toISOString(),
            );
            if (result.changes > 0) added++;
          }
        });
        await this.store.runExclusive(() => tx());
      }
    }
    return added;
  }
}

// Helper functions moved to CatCafeScanner.ts (F152 Phase A, KD-5)
