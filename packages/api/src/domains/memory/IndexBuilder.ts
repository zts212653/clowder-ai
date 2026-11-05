// F102: IIndexBuilder — scan docs, parse frontmatter, build/rebuild evidence index
// F152 Phase A: refactored to use RepoScanner strategy (KD-5)

import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, existsSync, readdirSync, statSync } from 'node:fs';
import { access, readFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { setImmediate as yieldToIo } from 'node:timers/promises';
import { CatCafeScanner } from './CatCafeScanner.js';
import { GenericRepoScanner } from './GenericRepoScanner.js';
import type {
  ConsistencyReport,
  EvidenceItem,
  EvidenceKind,
  IEmbeddingService,
  IIndexBuilder,
  MessageRecallSuppressionLease,
  RebuildResult,
  RepoScanner,
  ThreadIndexRefreshOptions,
} from './interfaces.js';

// Re-export for backward compatibility — external code imports KIND_DIRS from IndexBuilder
export { KIND_DIRS } from './CatCafeScanner.js';

import { mirrorDocAliases } from './doc-alias-mirror.js';
import {
  documentSourceClaims,
  publishDocumentSourceClaims,
  readDocumentSourceClaims,
} from './document-source-claims.js';
import {
  DOCUMENT_SOURCE_EDGE_PREDICATE,
  documentPathToAnchor,
  extractDocumentSourceEdges,
} from './document-source-edges.js';
import { embedPassages, INDEX_EMBED_BATCH_SIZE } from './embed-utils.js';
import { isMarkdownSourcePath } from './MarkdownPassageIndexer.js';
import { runMemoryScan } from './MemoryProcess.js';
import { buildSearchableMessageContent } from './message-search-content.js';
import { type PassageVectorStore, passageVectorKey } from './PassageVectorStore.js';
import { readPassageEmbeddingPage } from './passage-embedding-page.js';
import { PassageWarmupDiagnostics } from './passage-warmup-diagnostics.js';
import { prepareDocumentVectors } from './prepare-document-vectors.js';
import { type DocumentPassageSource, replaceDocumentPassages } from './replace-document-passages.js';
import type { SqliteEvidenceStore } from './SqliteEvidenceStore.js';
import { SIGNAL_FLAGS } from './summary-config.js';
import { projectThreadMessageSummary } from './thread-summary-projection.js';
import type { VectorStore } from './VectorStore.js';
import { createVectorInvalidator } from './vector-invalidation.js';

/**
 * Bump when scanner extraction logic changes (e.g., new fields derived from
 * the same source files). A version mismatch triggers an automatic full
 * re-index on the next rebuild(), so users only need to restart the API.
 *
 * History:
 *   1 — initial (implicit, pre-versioning)
 *   2 — CatCafeScanner: section headings → keywords (PR #1179)
 *   3 — Phase D: pathToAuthority backfill (authority derived from path)
 *   4 — F209 Phase B: entity mention extraction from docs/passages
 *   5 — visual artifact text indexing (SVG text + message block alt/caption)
 *   6 — non-feature docs use path anchors instead of feature_ids anchors (#2747)
 *   7 — architecture docs get first-class kind/authority/recency backfill
 *   8 — Markdown docs get raw passages; summary separators are skipped
 *   9 — temporal frontmatter fields: status/supersedes graph extraction
 *  10 — feature assets use path anchors; top-level feature specs own Fxxx
 *  11 — F287: approved Taste vignettes materialize complete decision passages
 *  12 — external-knowledge artifact roles, study tags, and authority backfill
 *  13 — pathToAuthority normalizes Windows backslash source paths (re-derive authority)
 *  14 — F321: quote text and owner comments backfill into canonical message passages
 *  15 — explicitly anchored supporting docs retain feature keywords across all scanners
 *  16 — split lessons hash and index their exact section body rather than only the title
 */
export const INDEXING_VERSION = 16;

/** Higher number = higher priority for anchor ownership */
const KIND_PRIORITY: Record<EvidenceKind, number> = {
  feature: 4,
  decision: 3,
  architecture: 3,
  plan: 2,
  discussion: 2,
  research: 2,
  diary: 1,
  session: 1,
  lesson: 1,
  thread: 1,
  'pack-knowledge': 0, // F129: pack knowledge — lowest priority, never overwrites global docs
};

const PASSAGE_EMBED_SCAN_BATCH_SIZE = 256;
const PASSAGE_WRITE_BATCH_SIZE = 16;

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

function computeThreadSourceHash(title: string, summary: string, keywords: string[]): string {
  return createHash('sha256').update(JSON.stringify({ title, summary, keywords })).digest('hex').slice(0, 16);
}

function projectThreadIndexTitle(thread: Pick<ThreadSnapshot, 'id' | 'title'>, hasRecallSuppression: boolean): string {
  // Thread titles may be generated from the first user message. Without title
  // provenance, a prepared/committed true recall must fail closed instead of
  // keeping a derived copy of the recalled body searchable.
  if (hasRecallSuppression) return `Thread ${thread.id.slice(0, 12)}`;
  return thread.title ?? `Thread ${thread.id.slice(0, 12)}`;
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
  contentBlocks?: readonly unknown[];
  richBlocks?: readonly unknown[];
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
function detectScanner(docsRoot: string, exclude?: string[]): { scanner: RepoScanner; scanRoot: string } {
  // Cat-café repos have features/ or decisions/ inside docsRoot
  if (existsSync(join(docsRoot, 'features')) || existsSync(join(docsRoot, 'decisions'))) {
    return { scanner: new CatCafeScanner(exclude), scanRoot: docsRoot };
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
  return { scanner: new CatCafeScanner(exclude), scanRoot: docsRoot };
}

class ThreadIndexSourceUnavailableError extends Error {
  constructor(cause: unknown) {
    super(`Thread index source unavailable: ${String(cause)}`, { cause });
  }
}

export class IndexBuilder implements IIndexBuilder {
  private readonly pendingMentionDocAnchors = new Set<string>();
  private indexMutationTail: Promise<unknown> = Promise.resolve();
  private readonly pendingDocumentVectorAnchors = new Set<string>();
  /** E-2: Set of threadIds that have been modified since last flush */
  private dirtyThreads = new Set<string>();
  private threadIndexRefresh: Promise<RebuildResult> | null = null;
  private dirtyFlushInFlight: Promise<number> | null = null;

  private passageEmbeddingWarmupInFlight: Promise<void> | null = null;

  /** F152 Phase A: pluggable scanner — defaults to CatCafeScanner */
  private readonly scanner: RepoScanner & {
    parseSingle?(f: string, r: string): import('./interfaces.js').ScannedEvidence | null;
  };

  /** F152 P1-1 fix: the root directory the scanner should scan (may differ from docsRoot) */
  private readonly scanRoot: string;

  constructor(
    private readonly store: SqliteEvidenceStore,
    private readonly docsRoot: string,
    private embedDeps?: {
      embedding: IEmbeddingService;
      vectorStore: VectorStore;
      passageVectorStore?: PassageVectorStore;
    },
    private readonly transcriptDataDir?: string,
    private readonly threadListFn?: ThreadListFn,
    private readonly messageListFn?: MessageListFn,
    private readonly excludeThreadIdsFn?: ExcludeThreadIdsFn,
    scanner?: RepoScanner,
    exclude?: string[],
  ) {
    this.store.invalidateVectorProjection();
    if (scanner) {
      this.scanner = scanner;
      this.scanRoot = docsRoot;
    } else {
      const detected = detectScanner(docsRoot, exclude);
      this.scanner = detected.scanner;
      this.scanRoot = detected.scanRoot;
    }
    this.store.setSourceRoot(this.scanRoot);
  }

  setEmbedDeps(
    deps:
      | {
          embedding: IEmbeddingService;
          vectorStore: VectorStore;
          passageVectorStore?: PassageVectorStore;
        }
      | undefined,
  ): void {
    if (
      this.embedDeps?.embedding !== deps?.embedding ||
      this.embedDeps?.vectorStore !== deps?.vectorStore ||
      this.embedDeps?.passageVectorStore !== deps?.passageVectorStore
    ) {
      this.store.invalidateVectorProjection();
    }
    this.embedDeps = deps;
  }

  addExcludePatterns(patterns: string[]): void {
    if (this.scanner instanceof CatCafeScanner) {
      this.scanner.addExcludePatterns(patterns);
    }
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

  rebuild(options?: Parameters<IndexBuilder['rebuildOnce']>[0]): Promise<RebuildResult> {
    return this.serializeIndexMutation(() => this.rebuildOnce(options));
  }

  private serializeIndexMutation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.indexMutationTail.then(async () => {
      try {
        return await operation();
      } finally {
        await this.flushPendingMentions();
      }
    });
    this.indexMutationTail = result.catch(() => undefined);
    return result;
  }

  private async flushPendingMentions(): Promise<void> {
    if (!this.pendingMentionDocAnchors.size) return;
    await this.store.refreshEntityMentions([...this.pendingMentionDocAnchors]);
    this.pendingMentionDocAnchors.clear();
  }

  private async discover(): Promise<import('./interfaces.js').ScannedEvidence[]> {
    await access(this.scanRoot);
    if (this.scanner instanceof CatCafeScanner || this.scanner instanceof GenericRepoScanner) {
      return runMemoryScan({
        kind: 'scan',
        scanner: this.scanner instanceof CatCafeScanner ? 'cat-cafe' : 'generic',
        root: this.scanRoot,
        excludes: this.scanner instanceof CatCafeScanner ? this.scanner.getExcludePatterns() : undefined,
        options: this.buildScanOptions(),
      });
    }
    await yieldToIo();
    return this.scanner.discover(this.scanRoot, this.buildScanOptions());
  }

  private async rebuildOnce(options?: {
    force?: boolean;
    deferThreadIndexing?: boolean;
    deferDocumentEmbedding?: boolean;
    onProgress?: (phase: string, percent: number) => void;
  }): Promise<RebuildResult> {
    this.store.invalidateVectorProjection();
    const report = options?.onProgress ?? (() => {});
    const start = Date.now();
    let indexed = 0;
    let skipped = 0;

    // Auto-force when scanner logic has changed since last rebuild
    const versionChanged = this.hasIndexingVersionChanged();
    const effectiveForce = options?.force || versionChanged;

    report('scanning', 0);
    // F152 Phase A: delegate to pluggable scanner (KD-5)
    const scannedItems = await this.discover();
    report('scanning', 15);
    const currentAnchors = new Set<string>();
    const documentPassageSources: DocumentPassageSource[] = [];

    for (const scanned of scannedItems) {
      await yieldToIo();
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
      if (existing && existing.sourcePath !== item.sourcePath) {
        const existingPriority = KIND_PRIORITY[existing.kind] ?? 0;
        const newPriority = KIND_PRIORITY[item.kind] ?? 0;
        const existingFileExists = existing.sourcePath ? existsSync(join(this.docsRoot, existing.sourcePath)) : false;
        if (existingFileExists) {
          // Anchor collision warning — two distinct files claim the same anchor
          console.warn(
            `[IndexBuilder] anchor collision: "${item.anchor}" claimed by ` +
              `"${item.sourcePath}" (${item.kind}, priority ${newPriority}) ` +
              `vs existing "${existing.sourcePath}" (${existing.kind}, priority ${existingPriority})`,
          );
          if (newPriority < existingPriority) {
            skipped++;
            continue;
          }
        }
      }

      this.pendingMentionDocAnchors.add(item.anchor);
      // A matching hash means passages completed, not merely metadata written.
      // Persist an incomplete stamp until the replacement transaction commits.
      await this.store.upsertForDocumentIndex(
        isMarkdownSourcePath(item.sourcePath) ? { ...item, sourceHash: undefined } : item,
      );
      this.pendingDocumentVectorAnchors.add(item.anchor);
      if (isMarkdownSourcePath(item.sourcePath)) {
        documentPassageSources.push({ item, passages: scanned.passages });
      }
      indexed++;
    }

    report('indexing', 30);

    await this.refreshRebuiltDocumentEdges(scannedItems);

    report('indexing', 40);
    await this.indexDocumentPassages(documentPassageSources);

    // Phase D-6: Index session digests (kind=session)
    if (this.transcriptDataDir) {
      const excludedThreadIds = this.excludeThreadIdsFn ? await this.excludeThreadIdsFn() : undefined;
      const sessionItems = await this.discoverSessionDigests(excludedThreadIds);
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
        this.pendingDocumentVectorAnchors.add(item.anchor);
        indexed++;
      }
    }

    // Runtime startup reuses persisted chat history; hydrate it only after listen.
    if (!options?.deferThreadIndexing) {
      try {
        const result = await this.refreshThreadIndex({ force: options?.force, onProgress: report });
        indexed += result.docsIndexed;
        skipped += result.docsSkipped;
      } catch (error) {
        if (!(error instanceof ThreadIndexSourceUnavailableError)) throw error;
        console.warn(`[IndexBuilder] thread index refresh failed; preserving existing history: ${String(error)}`);
      }
    }

    report('cleanup', 70);
    // Remove stale anchors that no longer exist on disk
    // Thread refresh owns thread cleanup, including transient listing failures.
    const db = this.store.getDb();
    const allAnchors = db.prepare('SELECT anchor FROM evidence_docs').all() as Array<{ anchor: string }>;
    const removedAnchors: string[] = [];
    for (const row of allAnchors) {
      if (!currentAnchors.has(row.anchor)) {
        if (row.anchor.startsWith('thread-')) continue;
        await this.store.deleteByAnchor(row.anchor);
        this.pendingDocumentVectorAnchors.delete(row.anchor);
        removedAnchors.push(row.anchor);
      }
    }
    if (removedAnchors.length > 0) {
      await this.store.runExclusive(() =>
        db.prepare('DELETE FROM document_vector_sources WHERE anchor NOT IN (SELECT anchor FROM evidence_docs)').run(),
      );
    }

    // F260 Phase A: mirror doc titles → doc_aliases (after stale removal, before embeddings)
    try {
      mirrorDocAliases(db);
    } catch {
      // fail-open: mirror errors don't block indexing
    }

    report('embedding', 80);
    // The model may have become ready after this pass began. Vector catch-up
    // reads the indexed rows and their source hashes without rescanning files.
    if (options?.deferDocumentEmbedding) {
      const deps = this.embedDeps;
      if (deps) {
        await prepareDocumentVectors(
          this.store,
          deps,
          this.pendingDocumentVectorAnchors,
          () => this.embedDeps?.embedding === deps.embedding && this.embedDeps.vectorStore === deps.vectorStore,
          Boolean(options.force),
        );
      }
    } else {
      try {
        await this.embedMissingDocumentVectors(Boolean(options?.force));
      } catch {
        // fail-open: lexical evidence remains usable without embeddings
      }
    }
    await publishDocumentSourceClaims(this.store, documentSourceClaims(scannedItems.map(({ item }) => item)));
    // Persist current indexing version so next startup can detect changes
    await this.storeIndexingVersion();
    await this.flushPendingMentions();
    report('done', 100);

    return { docsIndexed: indexed, docsSkipped: skipped, durationMs: Date.now() - start };
  }

  /** Catch up chat history without rescanning documents or blocking startup. */
  refreshThreadIndex(options: ThreadIndexRefreshOptions = {}): Promise<RebuildResult> {
    if (this.threadIndexRefresh) {
      return options.force
        ? this.threadIndexRefresh.then(() => this.refreshThreadIndex(options))
        : this.threadIndexRefresh;
    }
    const refresh = Promise.resolve(this.dirtyFlushInFlight)
      .then(() => this.refreshThreadIndexOnce(options))
      .finally(() => {
        if (this.threadIndexRefresh === refresh) this.threadIndexRefresh = null;
      });
    this.threadIndexRefresh = refresh;
    return refresh;
  }

  private async refreshThreadIndexOnce(options: ThreadIndexRefreshOptions): Promise<RebuildResult> {
    const start = Date.now();
    let indexed = 0;
    let skipped = 0;
    const { signal, onProgress: report = () => {} } = options;
    signal?.throwIfAborted();
    if (!this.threadListFn) return { docsIndexed: 0, docsSkipped: 0, durationMs: 0 };
    // Capture cleanup candidates before awaiting the live snapshot. Threads added
    // by a concurrent dirty flush must not be mistaken for deleted history.
    const previous = this.store
      .getDb()
      .prepare("SELECT anchor FROM evidence_docs WHERE anchor LIKE 'thread-%'")
      .all() as Array<{ anchor: string }>;
    let threads: ThreadSnapshot[];
    try {
      threads = await this.threadListFn();
    } catch (error) {
      throw new ThreadIndexSourceUnavailableError(error);
    }
    signal?.throwIfAborted();
    const anchors = new Set(threads.map((thread) => `thread-${thread.id}`));
    report('thread-summaries', 40);
    for (const thread of threads) {
      await yieldToIo(undefined, { signal });
      const suppressionVersion = this.threadSuppressionVersion(thread.id);
      const item = await this.buildThreadEvidenceItem(thread);
      signal?.throwIfAborted();
      const existing = await this.store.getByAnchor(item.anchor);
      if (!options.force && existing?.sourceHash === item.sourceHash) {
        skipped++;
        continue;
      }
      let current = true;
      await this.store.upsert([item], () => {
        signal?.throwIfAborted();
        if (suppressionVersion === this.threadSuppressionVersion(thread.id)) return true;
        this.markThreadDirty(thread.id);
        current = false;
        return false;
      });
      if (!current) {
        skipped++;
        continue;
      }
      this.pendingDocumentVectorAnchors.add(item.anchor);
      indexed++;
    }
    report('thread-passages', 55);
    await this.indexPassages(threads, signal);
    report('transcript-backfill', 62);
    if (this.transcriptDataDir) {
      for (const thread of threads) {
        await yieldToIo(undefined, { signal });
        await this.backfillPassagesFromTranscript(thread.id, signal);
      }
    }
    let removed = false;
    for (const { anchor } of previous) {
      signal?.throwIfAborted();
      if (anchors.has(anchor) || this.dirtyThreads.has(anchor.slice('thread-'.length))) continue;
      await this.store.deleteByAnchor(anchor);
      this.pendingDocumentVectorAnchors.delete(anchor);
      removed = true;
    }
    if (removed) {
      await this.store.runExclusive(() =>
        this.store
          .getDb()
          .prepare('DELETE FROM document_vector_sources WHERE anchor NOT IN (SELECT anchor FROM evidence_docs)')
          .run(),
      );
    }
    if (indexed > 0 || removed) {
      await this.store.runExclusive(() => mirrorDocAliases(this.store.getDb()));
    }
    return { docsIndexed: indexed, docsSkipped: skipped, durationMs: Date.now() - start };
  }

  private async storeDocumentVectorIfCurrent(
    row: { anchor: string; sourceHash: string | null },
    vector: Float32Array,
    vectorStore: VectorStore,
  ): Promise<boolean> {
    return this.store.runExclusive(() => {
      const db = this.store.getDb();
      const current = db
        .prepare('SELECT source_hash AS sourceHash FROM evidence_docs WHERE anchor = ?')
        .get(row.anchor) as { sourceHash: string | null } | undefined;
      if (!current || current.sourceHash !== row.sourceHash || this.embedDeps?.vectorStore !== vectorStore) {
        if (current) this.pendingDocumentVectorAnchors.add(row.anchor);
        return false;
      }
      vectorStore.upsert(row.anchor, vector);
      db.prepare('INSERT OR REPLACE INTO document_vector_sources (anchor, source_hash) VALUES (?, ?)').run(
        row.anchor,
        row.sourceHash ?? '',
      );
      this.pendingDocumentVectorAnchors.delete(row.anchor);
      return true;
    });
  }

  async embedMissingDocumentVectors(force = false): Promise<{ docsEmbedded: number; durationMs: number }> {
    const start = Date.now();
    const deps = this.embedDeps;
    if (!deps) return { docsEmbedded: 0, durationMs: Date.now() - start };
    const { embedding, vectorStore } = deps;
    const isCurrent = () => this.embedDeps?.embedding === embedding && this.embedDeps.vectorStore === vectorStore;
    await embedding.reprobeIfNeeded();
    if (!embedding.isReady() || !isCurrent()) return { docsEmbedded: 0, durationMs: Date.now() - start };

    const db = this.store.getDb();
    const pending = await prepareDocumentVectors(this.store, deps, this.pendingDocumentVectorAnchors, isCurrent, force);
    let docsEmbedded = 0;
    for (let offset = 0; offset < pending.length; offset += INDEX_EMBED_BATCH_SIZE) {
      if (!isCurrent()) break;
      const anchors = pending.slice(offset, offset + INDEX_EMBED_BATCH_SIZE);
      const batch = db
        .prepare(`SELECT anchor, title, summary, source_hash AS sourceHash FROM evidence_docs
          WHERE anchor IN (${anchors.map(() => '?').join(',')}) ORDER BY anchor`)
        .all(...anchors) as Array<{ anchor: string; title: string; summary: string | null; sourceHash: string | null }>;
      if (batch.length === 0) continue;
      const vectors = await embedding.embed(batch.map((row) => `${row.title} ${row.summary ?? ''}`));
      for (let i = 0; i < batch.length; i++) {
        if (!isCurrent()) break;
        if (await this.storeDocumentVectorIfCurrent(batch[i], vectors[i], vectorStore)) docsEmbedded++;
      }
    }
    return { docsEmbedded, durationMs: Date.now() - start };
  }

  isPassageWarmupActive(): boolean {
    return this.passageEmbeddingWarmupInFlight !== null;
  }

  startPassageEmbeddingWarmup(): void {
    // F209 fix: passage embedding is a recall accelerator (passage_fts stays canonical),
    // so it MUST NOT block rebuild()/listen(). Call this only after the API is listening.
    setImmediate(() => {
      void this.runPassageEmbeddingWarmup();
    });
  }

  private runPassageEmbeddingWarmup(): Promise<void> {
    if (this.passageEmbeddingWarmupInFlight) return this.passageEmbeddingWarmupInFlight;

    const observation = new PassageWarmupDiagnostics();
    const warmup = this.embedMissingPassages(undefined, observation)
      .catch(() => {
        observation.stop('rejected', 'unexpected-error');
        /* fail-open: passage vectors are an accelerator; passage_fts remains canonical */
      })
      .finally(() => {
        if (this.passageEmbeddingWarmupInFlight === warmup) {
          this.passageEmbeddingWarmupInFlight = null;
        }
        observation.finish();
      });
    this.passageEmbeddingWarmupInFlight = warmup;
    return warmup;
  }

  incrementalUpdate(changedPaths: string[]): Promise<void> {
    return this.serializeIndexMutation(() => this.incrementalUpdateOnce(changedPaths));
  }

  private async incrementalUpdateOnce(changedPaths: string[]): Promise<void> {
    // Two-pass: deletions first, then upserts.
    // This ensures that when a higher-priority owner is deleted and a lower-priority
    // doc is updated in the same batch, the deletion clears the way for the upsert.
    const toUpsert: Array<{ parsed: EvidenceItem; passages: string[]; rawContent?: string }> = [];
    const anchorsToDelete = new Set<string>();
    const claims = await this.loadDocumentSourceClaims();
    const affectedAnchors = new Set<string>();
    const documentPassageSources: DocumentPassageSource[] = [];

    for (const filePath of changedPaths) {
      const parsed = await this.parseSingleFile(filePath);
      const path = relative(this.scanRoot, filePath);
      const oldClaim = claims.get(path);
      if (oldClaim) affectedAnchors.add(oldClaim);
      if (parsed) {
        claims.set(path, parsed.parsed.anchor);
        affectedAnchors.add(parsed.parsed.anchor);
      } else claims.delete(path);
      // A changed explicit anchor transfers this source to a new identity. Release
      // its old identity through the same deletion/backfill path as a removed file.
      const previous = this.store
        .getDb()
        .prepare('SELECT anchor FROM evidence_docs WHERE source_path = ?')
        .all(relative(this.scanRoot, filePath)) as Array<{ anchor: string }>;
      for (const row of previous) {
        if (!parsed || row.anchor !== parsed.parsed.anchor) anchorsToDelete.add(row.anchor);
      }
      if (parsed) {
        toUpsert.push(parsed);
      }
    }

    // Pass 1: deletions (P1: sync vector deletion) + backfill from candidate docs
    const deletedAnchors: string[] = [];
    // Even a losing source affected its shared anchor and may have suppressed a self-path link.
    const pathLinkDependents = new Set(affectedAnchors);
    const db = this.store.getDb();
    for (const anchor of new Set([...affectedAnchors, ...anchorsToDelete])) {
      const inbound = db
        .prepare(
          "SELECT DISTINCT from_anchor AS anchor FROM edges WHERE to_anchor = ? AND relation = 'doc_link' AND provenance = 'content'",
        )
        .all(anchor) as Array<{ anchor: string }>;
      for (const source of inbound) pathLinkDependents.add(source.anchor);
    }
    for (const anchor of anchorsToDelete) {
      await this.store.deleteByAnchor(anchor);
      this.pendingDocumentVectorAnchors.delete(anchor);
      await this.store.runExclusive(() =>
        db.prepare('DELETE FROM document_vector_sources WHERE anchor = ?').run(anchor),
      );
      await this.refreshDocumentSourceEdges(anchor);
      deletedAnchors.push(anchor);
    }

    // Backfill only remaining claimants of retired identities; no corpus rediscovery.
    for (const anchor of deletedAnchors) {
      const candidates: typeof toUpsert = [];
      for (const [path, claimedAnchor] of claims) {
        if (claimedAnchor !== anchor) continue;
        const candidate = await this.parseSingleFile(resolve(this.scanRoot, path));
        if (candidate?.parsed.anchor === anchor) candidates.push(candidate);
      }
      candidates.sort((a, b) => (KIND_PRIORITY[b.parsed.kind] ?? 0) - (KIND_PRIORITY[a.parsed.kind] ?? 0));
      const best = candidates[0];
      if (best && !toUpsert.some((item) => item.parsed.anchor === anchor)) toUpsert.push(best);
    }

    // Pass 2: upserts (with kind-priority guard) + embed new/changed docs
    for (const { parsed, passages } of toUpsert) {
      const existing = await this.store.getByAnchor(parsed.anchor);
      if (existing) {
        const existingPriority = KIND_PRIORITY[existing.kind] ?? 0;
        const newPriority = KIND_PRIORITY[parsed.kind] ?? 0;
        if (newPriority < existingPriority) {
          continue;
        }
      }
      this.pendingMentionDocAnchors.add(parsed.anchor);
      await this.store.upsertForDocumentIndex(
        isMarkdownSourcePath(parsed.sourcePath) ? { ...parsed, sourceHash: undefined } : parsed,
      );
      this.pendingDocumentVectorAnchors.add(parsed.anchor);
      if (isMarkdownSourcePath(parsed.sourcePath)) {
        documentPassageSources.push({ item: parsed, passages });
      }
      // Embed the new/changed doc
      if (this.embedDeps?.embedding.isReady()) {
        try {
          const [vec] = await this.embedDeps.embedding.embed([`${parsed.title} ${parsed.summary ?? ''}`]);
          this.embedDeps.vectorStore.upsert(parsed.anchor, vec);
          await this.store.runExclusive(() =>
            this.store
              .getDb()
              .prepare('INSERT OR REPLACE INTO document_vector_sources (anchor, source_hash) VALUES (?, ?)')
              .run(parsed.anchor, parsed.sourceHash ?? ''),
          );
          this.pendingDocumentVectorAnchors.delete(parsed.anchor);
        } catch {
          // fail-open: skip embedding on error
        }
      }
    }

    await this.refreshIncrementalDocumentEdges(toUpsert, pathLinkDependents, claims);

    await this.indexDocumentPassages(documentPassageSources);

    await publishDocumentSourceClaims(this.store, claims);

    // F260 Phase A: refresh doc_aliases after incremental doc changes.
    // delete-rebuild pattern is O(N) but correct; acceptable for Phase A shadow-only scope.
    try {
      mirrorDocAliases(this.store.getDb());
    } catch {
      // fail-open: mirror errors don't block incremental update
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

  /** F152: Bridge — delegate single-file parsing to scanner (for incrementalUpdate) */
  private async parseSingleFile(filePath: string): Promise<{
    parsed: EvidenceItem;
    passages: string[];
    rawContent: string;
  } | null> {
    if ('parseSingle' in this.scanner && typeof this.scanner.parseSingle === 'function') {
      const scanned =
        this.scanner instanceof CatCafeScanner || this.scanner instanceof GenericRepoScanner
          ? await runMemoryScan<import('./interfaces.js').ScannedEvidence | null>({
              kind: 'scan',
              scanner: this.scanner instanceof CatCafeScanner ? 'cat-cafe' : 'generic',
              root: this.scanRoot,
              excludes: this.scanner instanceof CatCafeScanner ? this.scanner.getExcludePatterns() : undefined,
              singlePath: filePath,
            })
          : this.scanner.parseSingle(filePath, this.scanRoot);
      if (!scanned) return null;
      const sourceHash = scanned.rawContent
        ? createHash('sha256').update(scanned.rawContent).digest('hex').slice(0, 16)
        : undefined;
      return {
        parsed: { ...scanned.item, sourceHash, provenance: scanned.provenance },
        passages: scanned.passages,
        rawContent: scanned.rawContent,
      };
    }
    return null;
  }

  private async refreshRebuiltDocumentEdges(scanned: import('./interfaces.js').ScannedEvidence[]): Promise<void> {
    await this.store.runExclusive(() => {
      this.store.getDb().prepare(`DELETE FROM edges WHERE ${DOCUMENT_SOURCE_EDGE_PREDICATE}`).run();
    });
    const owners = this.store
      .getDb()
      .prepare('SELECT anchor, source_path AS sourcePath FROM evidence_docs')
      .all() as Array<{ anchor: string; sourcePath: string | null }>;
    const winners = new Map(owners.map((row) => [row.anchor, row.sourcePath]));
    const pathToAnchor = documentPathToAnchor(
      scanned.map(({ item }) => item),
      this.scanRoot,
    );
    for (const source of scanned) {
      await yieldToIo();
      if (!source.rawContent || winners.get(source.item.anchor) !== source.item.sourcePath) continue;
      for (const edge of extractDocumentSourceEdges(source.item, source.rawContent, pathToAnchor, this.scanRoot)) {
        await this.store.addEdge(edge);
      }
    }
  }

  private async loadDocumentSourceClaims(): Promise<Map<string, string>> {
    const existing = readDocumentSourceClaims(this.store);
    if (existing) return existing;
    // Legacy direct incremental entry lacks loser history. Initialize its derived graph once,
    // without rewriting document rows, passages or vectors. Normal startup rebuild already does this.
    const scanned = await this.discover();
    await this.refreshRebuiltDocumentEdges(scanned);
    return documentSourceClaims(scanned.map(({ item }) => item));
  }

  private async refreshIncrementalDocumentEdges(
    changed: Array<{ parsed: EvidenceItem; rawContent?: string }>,
    pathLinkDependents: Set<string>,
    claims: ReadonlyMap<string, string>,
  ): Promise<void> {
    const pathToAnchor = documentPathToAnchor(
      [...claims].map(([sourcePath, anchor]) => ({ sourcePath, anchor })),
      this.scanRoot,
    );
    const replacements = new Map<string, { parsed: EvidenceItem; rawContent?: string }>();
    for (const change of changed) {
      const winner = await this.store.getByAnchor(change.parsed.anchor);
      if (winner?.sourcePath === change.parsed.sourcePath) replacements.set(change.parsed.anchor, change);
    }
    // A Markdown path still names the same file after rekey, unlike an explicit [[old-anchor]] reference.
    // Reparse only sources whose resolved doc_link depended on an identity retired in this mutation.
    for (const anchor of pathLinkDependents) {
      if (replacements.has(anchor)) continue;
      const current = await this.store.getByAnchor(anchor);
      if (!current?.sourcePath) continue;
      const parsed = await this.parseSingleFile(resolve(this.scanRoot, current.sourcePath));
      if (parsed?.parsed.anchor === anchor) replacements.set(anchor, parsed);
    }
    for (const { parsed, rawContent } of replacements.values()) {
      await this.refreshDocumentSourceEdges(parsed.anchor, rawContent, parsed.sourcePath, pathToAnchor);
    }
  }

  private async refreshDocumentSourceEdges(
    anchor: string,
    rawContent = '',
    sourcePath?: string,
    pathToAnchor = new Map<string, string>(),
  ): Promise<void> {
    await this.store.runExclusive(() => {
      this.store
        .getDb()
        .prepare(`DELETE FROM edges WHERE from_anchor = ? AND ${DOCUMENT_SOURCE_EDGE_PREDICATE}`)
        .run(anchor);
    });
    for (const edge of extractDocumentSourceEdges({ anchor, sourcePath }, rawContent, pathToAnchor, this.scanRoot)) {
      await this.store.addEdge(edge);
    }
  }

  /**
   * D6: Discover sealed session digests from transcript data directory.
   * Scans dataDir/threads/{threadId}/{catId}/sessions/{sessionId}/digest.extractive.json
   */
  private async discoverSessionDigests(excludedThreadIds?: Set<string>): Promise<EvidenceItem[]> {
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
            const raw = await readFile(digestPath, 'utf-8');
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

  private threadSuppressionVersion(threadId: string): string {
    return [...this.suppressedMessageIds(threadId)].sort().join('\n');
  }

  private suppressedMessageIds(threadId: string): Set<string> {
    const rows = this.store
      .getDb()
      .prepare(
        `SELECT passage_id AS passageId
         FROM message_recall_index_suppressions
         WHERE doc_anchor = ?`,
      )
      .all(`thread-${threadId}`) as Array<{ passageId: string }>;
    return new Set(rows.map((row) => row.passageId.replace(/^msg-/, '')));
  }

  /** Shared projection for both full rebuilds and dirty-thread flushes. */
  private async buildThreadEvidenceItem(thread: ThreadSnapshot): Promise<EvidenceItem> {
    const suppressed = this.suppressedMessageIds(thread.id);
    const title = projectThreadIndexTitle(thread, suppressed.size > 0);
    const keywords = [...thread.participants, ...(thread.featureIds ?? [])];
    let summary = '';
    if (this.messageListFn) {
      try {
        summary = projectThreadMessageSummary(await this.messageListFn(thread.id, 100), suppressed);
      } catch {
        // Message projection is fail-open; the title remains the minimal index body.
      }
    }
    if (!summary && suppressed.size === 0) summary = thread.threadMemory?.summary ?? '';
    if (!summary) summary = title;
    return {
      anchor: `thread-${thread.id}`,
      kind: 'thread',
      status: 'active',
      title,
      summary,
      keywords: keywords.length > 0 ? keywords : undefined,
      sourcePath: `threads/${thread.id}`,
      sourceHash: computeThreadSourceHash(title, summary, keywords),
      updatedAt: new Date(thread.lastActiveAt).toISOString(),
    };
  }

  /**
   * F264 Gap F: persist a fail-closed suppression before the canonical recall
   * CAS. The SQLite transaction removes both direct passage and stale summary;
   * every rebuild path consults the same derived guard, so a concurrent flush
   * cannot re-create the body between index cleanup and MessageStore commit.
   */
  async suppressMessagePassage(threadId: string, messageId: string): Promise<MessageRecallSuppressionLease> {
    const docAnchor = `thread-${threadId}`;
    const passageId = `msg-${messageId}`;
    const lease: MessageRecallSuppressionLease = { threadId, messageId, leaseId: randomUUID() };
    await this.store.runExclusive(() => {
      const db = this.store.getDb();
      const invalidatePassage = createVectorInvalidator(db, 'passage_vectors');
      const invalidateDocument = createVectorInvalidator(db, 'evidence_vectors');
      db.transaction(() => {
        const passage = db
          .prepare(
            `SELECT content, speaker, position, created_at AS createdAt
             FROM evidence_passages
             WHERE doc_anchor = ? AND passage_id = ?`,
          )
          .get(docAnchor, passageId) as
          | { content: string; speaker: string | null; position: number | null; createdAt: string }
          | undefined;
        const doc = db
          .prepare(
            `SELECT title, summary, source_hash AS sourceHash, updated_at AS updatedAt
             FROM evidence_docs WHERE anchor = ?`,
          )
          .get(docAnchor) as
          | { title: string; summary: string | null; sourceHash: string | null; updatedAt: string }
          | undefined;
        db.prepare(
          `INSERT OR IGNORE INTO message_recall_index_snapshots
             (doc_anchor, passage_id, passage_content, passage_speaker, passage_position,
              passage_created_at, doc_title, doc_summary, doc_source_hash, doc_updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          docAnchor,
          passageId,
          passage?.content ?? null,
          passage?.speaker ?? null,
          passage?.position ?? null,
          passage?.createdAt ?? null,
          doc?.title ?? null,
          doc?.summary ?? null,
          doc?.sourceHash ?? null,
          doc?.updatedAt ?? null,
        );
        db.prepare(
          `INSERT INTO message_recall_index_suppressions
             (doc_anchor, passage_id, lease_id, state, prepared_at, committed_at)
           VALUES (?, ?, ?, 'prepared', ?, NULL)`,
        ).run(docAnchor, passageId, lease.leaseId, new Date().toISOString());
        db.prepare('DELETE FROM evidence_passages WHERE doc_anchor = ? AND passage_id = ?').run(docAnchor, passageId);
        db.prepare(
          `UPDATE evidence_docs
           SET title = ?, summary = '', source_hash = COALESCE(source_hash, '') || ?
           WHERE anchor = ?`,
        ).run(
          projectThreadIndexTitle({ id: threadId, title: null }, true),
          `:recall-suppressed:${messageId}`,
          docAnchor,
        );
        db.prepare("DELETE FROM doc_aliases WHERE doc_anchor = ? AND source = 'doc-title'").run(docAnchor);
        invalidatePassage(passageVectorKey(docAnchor, passageId));
        invalidateDocument(docAnchor);
      })();
    });
    try {
      await this.store.refreshEntityMentions([docAnchor]);
      this.markThreadDirty(threadId);
      await this.flushDirtyThreads();
      return lease;
    } catch (error) {
      try {
        await this.releaseMessagePassageSuppression(lease);
      } catch {
        // The original preparation failure is authoritative; startup
        // reconciliation still sees any lease that could not be released.
      }
      throw error;
    }
  }

  /** Release one prepared lease; restore the exact snapshot only after the last lease leaves. */
  async releaseMessagePassageSuppression(lease: MessageRecallSuppressionLease): Promise<boolean> {
    const docAnchor = `thread-${lease.threadId}`;
    const passageId = `msg-${lease.messageId}`;
    const restored = await this.store.runExclusive(() => {
      const db = this.store.getDb();
      const invalidatePassage = createVectorInvalidator(db, 'passage_vectors');
      const invalidateDocument = createVectorInvalidator(db, 'evidence_vectors');
      return db.transaction(() => {
        const row = db
          .prepare(
            `SELECT state FROM message_recall_index_suppressions
             WHERE doc_anchor = ? AND passage_id = ? AND lease_id = ?`,
          )
          .get(docAnchor, passageId, lease.leaseId) as { state: 'prepared' | 'committed' } | undefined;
        if (!row || row.state !== 'prepared') return false;
        db.prepare(
          `DELETE FROM message_recall_index_suppressions
           WHERE doc_anchor = ? AND passage_id = ? AND lease_id = ? AND state = 'prepared'`,
        ).run(docAnchor, passageId, lease.leaseId);
        const remaining = db
          .prepare(
            `SELECT 1 AS present FROM message_recall_index_suppressions
             WHERE doc_anchor = ? AND passage_id = ? LIMIT 1`,
          )
          .get(docAnchor, passageId);
        if (remaining) return false;

        const snapshot = db
          .prepare(
            `SELECT passage_content AS passageContent, passage_speaker AS passageSpeaker,
                    passage_position AS passagePosition, passage_created_at AS passageCreatedAt,
                    doc_title AS docTitle, doc_summary AS docSummary,
                    doc_source_hash AS docSourceHash, doc_updated_at AS docUpdatedAt
             FROM message_recall_index_snapshots
             WHERE doc_anchor = ? AND passage_id = ?`,
          )
          .get(docAnchor, passageId) as
          | {
              passageContent: string | null;
              passageSpeaker: string | null;
              passagePosition: number | null;
              passageCreatedAt: string | null;
              docTitle: string | null;
              docSummary: string | null;
              docSourceHash: string | null;
              docUpdatedAt: string | null;
            }
          | undefined;
        if (snapshot?.passageContent !== null && snapshot?.passageContent !== undefined) {
          db.prepare(
            `INSERT INTO evidence_passages
               (doc_anchor, passage_id, content, speaker, position, created_at)
             VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT(doc_anchor, passage_id) DO UPDATE SET
               content = excluded.content,
               speaker = excluded.speaker,
               position = excluded.position,
               created_at = excluded.created_at`,
          ).run(
            docAnchor,
            passageId,
            snapshot.passageContent,
            snapshot.passageSpeaker,
            snapshot.passagePosition,
            snapshot.passageCreatedAt,
          );
        }
        if (snapshot?.docTitle !== null && snapshot?.docTitle !== undefined) {
          db.prepare(
            `UPDATE evidence_docs
             SET title = ?, summary = ?, source_hash = ?, updated_at = ?
             WHERE anchor = ?`,
          ).run(snapshot.docTitle, snapshot.docSummary, snapshot.docSourceHash, snapshot.docUpdatedAt, docAnchor);
        }
        db.prepare('DELETE FROM message_recall_index_snapshots WHERE doc_anchor = ? AND passage_id = ?').run(
          docAnchor,
          passageId,
        );
        mirrorDocAliases(db);
        invalidatePassage(passageVectorKey(docAnchor, passageId));
        invalidateDocument(docAnchor);
        return true;
      })();
    });
    if (!restored) return false;
    await this.store.refreshEntityMentions([docAnchor]);
    await this.restoreSuppressionEmbeddings(docAnchor);
    return true;
  }

  /** Commit every concurrent lease so a losing request cannot release the winner's guard. */
  async finalizeMessagePassageSuppression(lease: MessageRecallSuppressionLease): Promise<void> {
    const docAnchor = `thread-${lease.threadId}`;
    const passageId = `msg-${lease.messageId}`;
    await this.store.runExclusive(() => {
      const db = this.store.getDb();
      const invalidatePassage = createVectorInvalidator(db, 'passage_vectors');
      const invalidateDocument = createVectorInvalidator(db, 'evidence_vectors');
      db.transaction(() => {
        const exists = db
          .prepare(
            `SELECT 1 AS present FROM message_recall_index_suppressions
             WHERE doc_anchor = ? AND passage_id = ? AND lease_id = ?`,
          )
          .get(docAnchor, passageId, lease.leaseId);
        if (!exists) return;
        const now = new Date().toISOString();
        db.prepare(
          `UPDATE message_recall_index_suppressions
           SET state = 'committed', committed_at = COALESCE(committed_at, ?)
           WHERE doc_anchor = ? AND passage_id = ?`,
        ).run(now, docAnchor, passageId);
        db.prepare('DELETE FROM message_recall_index_snapshots WHERE doc_anchor = ? AND passage_id = ?').run(
          docAnchor,
          passageId,
        );
        db.prepare('DELETE FROM summary_segments WHERE thread_id = ?').run(lease.threadId);
        db.prepare(
          `UPDATE evidence_docs
           SET summary = '', source_hash = COALESCE(source_hash, '') || ?
           WHERE anchor = ?`,
        ).run(`:recall-committed:${lease.messageId}`, docAnchor);
        db.prepare(
          `UPDATE summary_state SET
             last_summarized_message_id = NULL,
             pending_message_count = 0,
             pending_token_count = 0,
             pending_signal_flags = 0,
             carry_over = 1,
             summary_type = 'concat',
             last_abstractive_at = NULL,
             abstractive_token_count = NULL
           WHERE thread_id = ?`,
        ).run(lease.threadId);
        invalidatePassage(passageVectorKey(docAnchor, passageId));
        invalidateDocument(docAnchor);
      })();
    });
    await this.store.refreshEntityMentions([docAnchor]);
  }

  private async restoreSuppressionEmbeddings(docAnchor: string): Promise<void> {
    if (this.embedDeps?.embedding.isReady()) {
      const doc = this.store
        .getDb()
        .prepare('SELECT title, summary, source_hash AS sourceHash FROM evidence_docs WHERE anchor = ?')
        .get(docAnchor) as { title: string; summary: string | null; sourceHash: string | null } | undefined;
      if (doc) {
        try {
          const [vector] = await this.embedDeps.embedding.embed([`${doc.title} ${doc.summary ?? ''}`]);
          await this.storeDocumentVectorIfCurrent(
            { anchor: docAnchor, sourceHash: doc.sourceHash },
            vector,
            this.embedDeps.vectorStore,
          );
        } catch {
          // Lexical restoration is authoritative; vector repair retries during warmup.
        }
      }
    }
    await this.embedMissingPassages([docAnchor]);
  }

  /**
   * Resolve the only crash window in the cross-store protocol. A prepared row
   * is retained iff canonical MessageStore truth is recalled; otherwise it is
   * released and the normal thread rebuild restores the searchable passage.
   */
  async reconcileMessageRecallSuppressions(
    isRecalled: (threadId: string, messageId: string) => boolean | Promise<boolean>,
  ): Promise<{ retained: number; released: number }> {
    const rows = this.store
      .getDb()
      .prepare(
        `SELECT doc_anchor AS docAnchor, passage_id AS passageId, lease_id AS leaseId
         FROM message_recall_index_suppressions
         GROUP BY doc_anchor, passage_id`,
      )
      .all() as Array<{ docAnchor: string; passageId: string; leaseId: string }>;
    const released: Array<{ docAnchor: string; passageId: string }> = [];
    let retained = 0;
    for (const row of rows) {
      const threadId = row.docAnchor.replace(/^thread-/, '');
      const messageId = row.passageId.replace(/^msg-/, '');
      if (await isRecalled(threadId, messageId)) {
        await this.finalizeMessagePassageSuppression({ threadId, messageId, leaseId: row.leaseId });
        retained++;
      } else {
        released.push(row);
      }
    }

    if (released.length > 0) {
      for (const row of released) {
        const leases = this.store
          .getDb()
          .prepare(
            `SELECT lease_id AS leaseId FROM message_recall_index_suppressions
             WHERE doc_anchor = ? AND passage_id = ? AND state = 'prepared'`,
          )
          .all(row.docAnchor, row.passageId) as Array<{ leaseId: string }>;
        for (const lease of leases) {
          await this.releaseMessagePassageSuppression({
            threadId: row.docAnchor.replace(/^thread-/, ''),
            messageId: row.passageId.replace(/^msg-/, ''),
            leaseId: lease.leaseId,
          });
        }
      }
    }
    return { retained, released: released.length };
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
          pending_signal_flags = pending_signal_flags | ?,
          pending_input_revision = pending_input_revision + 1
      `).run(threadId, tokenEstimate, signalFlags, tokenEstimate, signalFlags);
      })
      .catch(() => {
        /* fail-open */
      });
  }

  /** Flush dirty threads: re-index only the threads that have been marked dirty. */
  async flushDirtyThreads(): Promise<number> {
    if (this.threadIndexRefresh) return 0;
    if (this.dirtyFlushInFlight) return this.dirtyFlushInFlight;
    const flush = this.flushDirtyThreadsOnce().finally(() => {
      if (this.dirtyFlushInFlight === flush) this.dirtyFlushInFlight = null;
    });
    this.dirtyFlushInFlight = flush;
    return flush;
  }

  private async flushDirtyThreadsOnce(): Promise<number> {
    if (this.dirtyThreads.size === 0 || !this.threadListFn) return 0;

    const dirtyIds = [...this.dirtyThreads];
    this.dirtyThreads.clear();

    let threads: ThreadSnapshot[];
    try {
      threads = await this.threadListFn();
    } catch {
      for (const threadId of dirtyIds) this.dirtyThreads.add(threadId);
      return 0;
    }

    const threadMap = new Map(threads.map((t) => [t.id, t]));
    const dirtySnapshots = dirtyIds
      .map((id) => threadMap.get(id))
      .filter((thread): thread is ThreadSnapshot => thread !== undefined);
    try {
      const documentsToEmbed = await this.upsertDirtyThreadDocuments(dirtySnapshots);

      // Lexical message recall must be available for the entire dirty batch before
      // any document embedding can wait on a provider. Vectors remain accelerators.
      if (dirtySnapshots.length > 0) await this.indexPassages(dirtySnapshots);
      await this.embedDirtyThreadDocuments(documentsToEmbed);
      if (dirtySnapshots.length > 0) {
        await this.embedMissingPassages(dirtySnapshots.map((t) => `thread-${t.id}`));
      }
      return documentsToEmbed.length;
    } catch (error) {
      // A batch may already be committed. Idempotent retry must still visit the
      // remaining messages/threads, preserving marks that arrived during flush.
      for (const threadId of dirtyIds) this.dirtyThreads.add(threadId);
      throw error;
    }
  }

  private async upsertDirtyThreadDocuments(threads: ThreadSnapshot[]): Promise<EvidenceItem[]> {
    const items: EvidenceItem[] = [];
    for (const thread of threads) {
      const suppressionVersion = this.threadSuppressionVersion(thread.id);
      const item = await this.buildThreadEvidenceItem(thread);
      const anchor = item.anchor;

      const existing = await this.store.getByAnchor(anchor);
      if (existing?.sourceHash === item.sourceHash) continue; // unchanged

      let current = true;
      await this.store.upsert([item], () => {
        if (suppressionVersion === this.threadSuppressionVersion(thread.id)) return true;
        this.markThreadDirty(thread.id);
        current = false;
        return false;
      });
      if (!current) continue;
      this.pendingDocumentVectorAnchors.add(anchor);
      items.push(item);
    }
    return items;
  }

  private async embedDirtyThreadDocuments(items: EvidenceItem[]): Promise<void> {
    const deps = this.embedDeps;
    if (!deps?.embedding.isReady()) return;
    for (const item of items) {
      try {
        const [vec] = await deps.embedding.embed([`${item.title} ${item.summary ?? ''}`]);
        const stored = await this.storeDocumentVectorIfCurrent(
          { anchor: item.anchor, sourceHash: item.sourceHash ?? null },
          vec,
          deps.vectorStore,
        );
        if (!stored) this.markThreadDirty(item.anchor.slice('thread-'.length));
      } catch {
        // Keep the pending source stamp for a later vector retry.
      }
    }
  }

  /** F209 Phase A: embed newly indexed raw passages without blocking lexical recall. */
  private async embedMissingPassages(docAnchors?: string[], observation?: PassageWarmupDiagnostics): Promise<void> {
    const deps = this.embedDeps;
    const passageVectors = deps?.passageVectorStore;
    if (!passageVectors) {
      observation?.stop('retired', 'no-dependencies');
      return;
    }

    try {
      await deps.embedding.reprobeIfNeeded();
    } catch {
      observation?.stop('rejected', 'probe-error');
      return; // Optional vector work cannot fail a canonical dirty-thread flush.
    }
    const db = this.store.getDb();
    let lastId = 0;
    let consecutiveErrors = 0;

    for (;;) {
      // Resolved promises only yield to microtasks. Warm pages still need an
      // actual I/O turn, and service deactivation must stop the remaining scan.
      await yieldToIo();
      if (this.embedDeps !== deps || !deps.embedding.isReady()) {
        observation?.stop('retired', 'dependencies-unavailable');
        return;
      }
      let page: ReturnType<typeof readPassageEmbeddingPage>;
      try {
        page = readPassageEmbeddingPage(db, passageVectors, lastId, PASSAGE_EMBED_SCAN_BATCH_SIZE, docAnchors);
      } catch {
        observation?.stop('rejected', 'metadata-read-error');
        // Structural read errors cannot be repaired by scanning the next page.
        return;
      }
      if (!page) {
        if (observation) observation.scanExhausted = true;
        return;
      }
      if (observation) {
        observation.pagesRead++;
        observation.metadataRows += page.metadataRows;
        observation.missingBodies += page.passages.length;
      }
      lastId = page.lastId;

      try {
        await embedPassages({
          passages: page.passages,
          embedding: deps.embedding,
          passageVectorStore: passageVectors,
          commitBatch: (batch, vectors) => {
            // Provider work has returned even if writer admission or its dependency fence retires the commit.
            if (observation) observation.returnedBatches++;
            return this.store.runExclusive(() => {
              if (this.embedDeps !== deps) {
                observation?.stop('retired', 'dependencies-changed');
                return;
              }
              const current = db.prepare(
                'SELECT content FROM evidence_passages WHERE doc_anchor = ? AND passage_id = ?',
              );
              for (let i = 0; i < batch.length; i++) {
                const row = batch[i];
                const live = current.get(row.docAnchor, row.passageId) as { content: string } | undefined;
                if (live?.content !== row.content) {
                  if (observation) observation.sourceChanged++;
                  continue;
                }
                passageVectors.upsert(passageVectorKey(row.docAnchor, row.passageId), vectors[i]);
                if (observation) observation.committedVectors++;
              }
            });
          },
        });
        consecutiveErrors = 0;
      } catch {
        // Batch-level fail-open: skip this batch, continue with the next.
        // passage_fts remains canonical — vectors are an accelerator.
        consecutiveErrors++;
        if (observation) observation.batchFailures++;
        if (consecutiveErrors >= 3) {
          observation?.stop('rejected', 'consecutive-batch-errors');
          // 3 consecutive batch failures → embedding service likely down, stop gracefully
          return;
        }
      }
    }
  }

  private async indexDocumentPassages(sources: DocumentPassageSource[]): Promise<void> {
    const docs = sources.filter((source) => isMarkdownSourcePath(source.item.sourcePath));
    if (docs.length === 0) return;

    // Keep document transactions atomic, but amortize maintenance over bounded
    // groups: a checkpoint per small file makes cold Windows startup disk-bound.
    const db = this.store.getDb();
    const complete = db.prepare('UPDATE evidence_docs SET source_hash = ? WHERE anchor = ?');
    for (let offset = 0; offset < docs.length; offset += 16) {
      await this.store.runCheckpointedBatch(async () => {
        for (const source of docs.slice(offset, offset + 16)) {
          await yieldToIo();
          db.transaction(() => {
            replaceDocumentPassages(db, [source], createVectorInvalidator(db, 'passage_vectors'));
            complete.run(source.item.sourceHash ?? null, source.item.anchor);
          })();
        }
      });
    }
    for (const doc of docs) this.pendingMentionDocAnchors.add(doc.item.anchor);
  }

  /**
   * E-3: Index thread messages as passages in evidence_passages table.
   * For each thread, fetches messages via messageListFn and upserts into evidence_passages.
   */
  private async indexPassages(threads: ThreadSnapshot[], signal?: AbortSignal): Promise<void> {
    if (!this.messageListFn) return;
    const db = this.store.getDb();
    const contentChangedStmt = db.prepare(
      'SELECT content IS NOT ? AS changed FROM evidence_passages WHERE doc_anchor = ? AND passage_id = ?',
    );

    // Phase I (AC-I2): never delete missing passages on rebuild.
    // Existing returned messages still need to refresh so new block metadata can backfill.
    const upsertStmt = db.prepare(`
      INSERT INTO evidence_passages
      (doc_anchor, passage_id, content, speaker, position, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(doc_anchor, passage_id) DO UPDATE SET
        content = excluded.content,
        speaker = excluded.speaker,
        position = excluded.position,
        created_at = excluded.created_at
      WHERE evidence_passages.content IS NOT excluded.content
        OR evidence_passages.speaker IS NOT excluded.speaker
        OR evidence_passages.position IS NOT excluded.position
        OR evidence_passages.created_at IS NOT excluded.created_at
    `);

    for (const thread of threads) {
      await yieldToIo(undefined, { signal });
      let messages: StoredMessageSnapshot[];
      try {
        messages = await this.messageListFn(thread.id, 2000);
      } catch {
        signal?.throwIfAborted();
        continue;
      }

      const tx = db.transaction(
        (msgs: StoredMessageSnapshot[], offset: number, invalidateVector: (key: string) => void) => {
          signal?.throwIfAborted();
          const suppressed = this.suppressedMessageIds(thread.id);
          for (let i = 0; i < msgs.length; i++) {
            const msg = msgs[i];
            if (suppressed.has(msg.id)) continue;
            const content = buildSearchableMessageContent(msg);
            if (!content) continue;
            const docAnchor = `thread-${thread.id}`;
            const passageId = `msg-${msg.id}`;
            const previous = contentChangedStmt.get(content, docAnchor, passageId) as { changed: number } | undefined;
            const result = upsertStmt.run(
              docAnchor,
              passageId,
              content,
              msg.catId ?? 'user',
              offset + i,
              new Date(msg.timestamp).toISOString(),
            );
            if (result.changes > 0) {
              if (previous?.changed !== 0) invalidateVector(passageVectorKey(docAnchor, passageId));
            }
          }
        },
      );

      // Route batch insert through single-writer queue (F163 AC-A5)
      for (let offset = 0; offset < messages.length; offset += PASSAGE_WRITE_BATCH_SIZE) {
        await this.store.runCheckpointedBatch(() =>
          tx(
            messages.slice(offset, offset + PASSAGE_WRITE_BATCH_SIZE),
            offset,
            createVectorInvalidator(db, 'passage_vectors'),
          ),
        );
      }
      // Passage triggers persist this marker in the same transaction as the
      // source rows. Maintenance can reject after commit; unchanged retry must
      // still finish the publication (startup consumes the same durable queue).
      const docAnchor = `thread-${thread.id}`;
      const pending = db.prepare('SELECT 1 FROM entity_mention_pending_docs WHERE doc_anchor = ?').get(docAnchor);
      if (pending) await this.store.refreshEntityMentions([docAnchor]);
    }
  }

  /**
   * Phase I (AC-I1): Backfill passages from JSONL transcript events.
   * Reads events.jsonl files, aggregates text chunks per invocationId,
   * and inserts as passages with INSERT OR IGNORE (idempotent).
   * Returns count of newly added passages.
   */
  async backfillPassagesFromTranscript(threadId: string, signal?: AbortSignal): Promise<number> {
    signal?.throwIfAborted();
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
    let position =
      10000 +
      (
        db
          .prepare(
            "SELECT COALESCE(MAX(position) - 9999, 0) AS count FROM evidence_passages WHERE doc_anchor = ? AND passage_id LIKE 'transcript-%'",
          )
          .get(`thread-${threadId}`) as { count: number }
      ).count;
    const checkpointRead = db.prepare('SELECT fingerprint FROM transcript_backfill_files WHERE file_path = ?');
    const checkpointWrite = db.prepare(
      'INSERT OR REPLACE INTO transcript_backfill_files (file_path, fingerprint) VALUES (?, ?)',
    );
    const completedFiles: Array<{ path: string; fingerprint: string }> = [];

    for (const catId of catDirs) {
      signal?.throwIfAborted();
      const sessionsDir = join(threadDir, catId, 'sessions');
      let sessionDirs: string[];
      try {
        sessionDirs = readdirSync(sessionsDir).filter((e) => !e.startsWith('.'));
      } catch {
        signal?.throwIfAborted();
        continue;
      }

      for (const sessionId of sessionDirs) {
        signal?.throwIfAborted();
        const eventsPath = join(sessionsDir, sessionId, 'events.jsonl');
        const checkpointPath = `${threadId}/${catId}/${sessionId}/events.jsonl`;
        let fingerprint: string;
        try {
          const stat = statSync(eventsPath);
          fingerprint = `${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
        } catch {
          continue;
        }
        const checkpoint = checkpointRead.get(checkpointPath) as { fingerprint: string } | undefined;
        if (checkpoint?.fingerprint === fingerprint) continue;

        // Accumulate text chunks by invocationId
        const invocationTexts = new Map<string, { text: string; t: number; catId: string }>();

        try {
          const lines = createInterface({
            input: createReadStream(eventsPath, { encoding: 'utf-8', signal }),
            crlfDelay: Infinity,
          });
          for await (const line of lines) {
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
        } catch {
          continue;
        }

        // Insert accumulated text per invocation — routed through single-writer queue (F163 AC-A5)
        const exists = db.prepare('SELECT 1 FROM evidence_passages WHERE doc_anchor=? AND passage_id=?');
        const tx = db.transaction((entries: Array<[string, { text: string; t: number; catId: string }]>) => {
          signal?.throwIfAborted();
          for (const [invId, data] of entries) {
            if (exists.get(`thread-${threadId}`, `transcript-${invId}`)) continue;
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
        const entries = [...invocationTexts];
        for (let offset = 0; offset < entries.length; offset += PASSAGE_WRITE_BATCH_SIZE) {
          await this.store.runCheckpointedBatch(() => tx(entries.slice(offset, offset + PASSAGE_WRITE_BATCH_SIZE)));
        }
        completedFiles.push({ path: checkpointPath, fingerprint });
        if (completedFiles.length % 16 === 0) await new Promise<void>((resolve) => setImmediate(resolve));
      }
    }
    if (completedFiles.length > 0) {
      await this.store.refreshEntityMentions([`thread-${threadId}`]);
      await this.store.runExclusive(() =>
        db.transaction(() => {
          for (const file of completedFiles) checkpointWrite.run(file.path, file.fingerprint);
        })(),
      );
    }
    return added;
  }
}

// Helper functions moved to CatCafeScanner.ts (F152 Phase A, KD-5)
