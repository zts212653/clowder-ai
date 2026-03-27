// F102: IIndexBuilder — scan docs, parse frontmatter, build/rebuild evidence index

import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from 'node:fs';
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
import { SIGNAL_FLAGS } from './summary-config.js';
import type { VectorStore } from './VectorStore.js';

const KIND_DIRS: Record<string, EvidenceKind> = {
  features: 'feature',
  decisions: 'decision',
  plans: 'plan',
  lessons: 'lesson',
  discussions: 'discussion',
  research: 'research',
  phases: 'plan',
  reflections: 'lesson',
  methods: 'lesson',
  episodes: 'lesson',
  postmortems: 'lesson',
  guides: 'plan',
  stories: 'lesson', // 猫猫的 soul — 名字故事、经历、成长记忆
};

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

export class IndexBuilder implements IIndexBuilder {
  /** E-2: Set of threadIds that have been modified since last flush */
  private dirtyThreads = new Set<string>();

  constructor(
    private readonly store: SqliteEvidenceStore,
    private readonly docsRoot: string,
    private embedDeps?: { embedding: IEmbeddingService; vectorStore: VectorStore },
    private readonly transcriptDataDir?: string,
    private readonly threadListFn?: ThreadListFn,
    private readonly messageListFn?: MessageListFn,
    private readonly excludeThreadIdsFn?: ExcludeThreadIdsFn,
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

    // E8: Split lessons-learned.md into per-lesson entries for better recall
    const lessonItems = this.splitLessonsLearned();
    for (const item of lessonItems) {
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

    // Phase D: auto-extract edges from frontmatter cross-references (AC-D18, KD-29)
    // Clear stale auto-generated 'related' edges before re-extracting (P1 fix: only-increase bug)
    this.store.getDb().prepare("DELETE FROM edges WHERE relation = 'related'").run();

    for (const file of files) {
      let content: string;
      try {
        content = readFileSync(file.path, 'utf-8');
      } catch {
        continue;
      }
      const fm = extractFrontmatter(content);
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
    if (this.messageListFn && this.threadListFn && !threadListFailed) {
      let threads: ThreadSnapshot[];
      try {
        threads = await this.threadListFn();
      } catch {
        threads = [];
      }
      await this.indexPassages(threads);
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

    // Helper: recursively scan a directory for .md files
    const scanDir = (dirPath: string, kind: EvidenceKind, depth = 0) => {
      if (depth > 10) return; // prevent infinite recursion
      try {
        const entries = readdirSync(dirPath);
        for (const entry of entries) {
          const fullPath = join(dirPath, entry);
          try {
            // P2 fix: skip symlinks to prevent directory loops
            const lst = lstatSync(fullPath);
            if (lst.isSymbolicLink()) continue;

            if (lst.isFile() && entry.endsWith('.md')) {
              results.push({ path: fullPath, kind });
            } else if (lst.isDirectory()) {
              scanDir(fullPath, kind, depth + 1);
            }
          } catch {
            // skip inaccessible entries
          }
        }
      } catch {
        // Directory doesn't exist — skip
      }
    };

    // Scan primary docs directories
    for (const [dir, kind] of Object.entries(KIND_DIRS)) {
      scanDir(join(this.docsRoot, dir), kind);
    }

    // Scan archive directories (same structure as docs/)
    const archiveRoot = join(this.docsRoot, 'archive');
    try {
      const archiveEntries = readdirSync(archiveRoot);
      for (const dateDir of archiveEntries) {
        const datePath = join(archiveRoot, dateDir);
        try {
          if (!statSync(datePath).isDirectory()) continue;
          // Each archive date folder mirrors docs/ structure
          for (const [dir, kind] of Object.entries(KIND_DIRS)) {
            scanDir(join(datePath, dir), kind);
          }
        } catch {
          // skip
        }
      }
    } catch {
      // archive doesn't exist — skip
    }

    // Also scan top-level .md files in docs/ (VISION.md, SOP.md, BACKLOG.md, etc.)
    try {
      const topFiles = readdirSync(this.docsRoot);
      for (const entry of topFiles) {
        if (!entry.endsWith('.md')) continue;
        const fullPath = join(this.docsRoot, entry);
        try {
          if (statSync(fullPath).isFile()) {
            results.push({ path: fullPath, kind: 'plan' as EvidenceKind });
          }
        } catch {
          // skip
        }
      }
    } catch {
      // skip
    }

    return results;
  }

  /**
   * E8: Split lessons-learned.md into per-lesson evidence items for better recall.
   * Each ### LL-NNN section becomes a separate evidence_docs entry.
   */
  private splitLessonsLearned(): EvidenceItem[] {
    const filePath = join(this.docsRoot, 'lessons-learned.md');
    let content: string;
    try {
      content = readFileSync(filePath, 'utf-8');
    } catch {
      return [];
    }

    const results: EvidenceItem[] = [];
    const sections = content.split(/^### /m).slice(1); // split on ### headings, skip preamble

    for (const section of sections) {
      const titleMatch = section.match(/^(LL-\d+):\s*(.+)/);
      if (!titleMatch) continue;

      const llId = titleMatch[1]; // e.g., LL-015
      const title = `${llId}: ${titleMatch[2].trim()}`;
      const body = section.slice(section.indexOf('\n') + 1).trim();
      const summary = body.length > 300 ? `${body.slice(0, 297)}...` : body;
      const sourceHash = createHash('sha256').update(section).digest('hex').slice(0, 16);

      // Extract keywords from the section
      const keywords: string[] = [];
      const kwMatch = body.match(/关联：(.+)/);
      if (kwMatch) {
        keywords.push(
          ...kwMatch[1]
            .split(/[|,]/)
            .map((s) => s.trim())
            .filter(Boolean),
        );
      }

      results.push({
        anchor: llId,
        kind: 'lesson',
        status: 'active',
        title,
        summary,
        keywords: keywords.length > 0 ? keywords : undefined,
        sourcePath: 'lessons-learned.md',
        sourceHash,
        updatedAt: new Date().toISOString(),
      });
    }

    return results;
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
    try {
      const db = this.store.getDb();
      const tokenEstimate = Math.ceil(messageContent.length / 4);

      let signalFlags = 0;
      const lower = messageContent.toLowerCase();
      if (/(?:决定|agreed|kd-|decided|confirmed)/i.test(lower)) signalFlags |= SIGNAL_FLAGS.DECISION;
      if (/(?:\.ts|\.js|\.tsx|pr\s*#|commit|merge|diff)/i.test(lower)) signalFlags |= SIGNAL_FLAGS.CODE;
      if (/(?:fix|bug|error|修复|报错)/i.test(lower)) signalFlags |= SIGNAL_FLAGS.ERROR_FIX;

      db.prepare(`
        INSERT INTO summary_state (thread_id, pending_message_count, pending_token_count, pending_signal_flags, summary_type)
        VALUES (?, 1, ?, ?, 'concat')
        ON CONFLICT(thread_id) DO UPDATE SET
          pending_message_count = pending_message_count + 1,
          pending_token_count = pending_token_count + ?,
          pending_signal_flags = pending_signal_flags | ?
      `).run(threadId, tokenEstimate, signalFlags, tokenEstimate, signalFlags);
    } catch {
      // fail-open
    }
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

    const upsertStmt = db.prepare(`
      INSERT OR REPLACE INTO evidence_passages
      (doc_anchor, passage_id, content, speaker, position, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    // P1 fix: clear stale passages before re-inserting (passage only-increase bug)
    const deleteByAnchorStmt = db.prepare('DELETE FROM evidence_passages WHERE doc_anchor = ?');

    for (const thread of threads) {
      let messages: StoredMessageSnapshot[];
      try {
        messages = await this.messageListFn(thread.id, 2000);
      } catch {
        continue;
      }

      const tx = db.transaction((msgs: StoredMessageSnapshot[]) => {
        // Clear old passages for this thread before inserting current ones
        deleteByAnchorStmt.run(`thread-${thread.id}`);
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

      tx(messages);
    }
  }

  private parseFile(filePath: string): EvidenceItem | null {
    let content: string;
    try {
      content = readFileSync(filePath, 'utf-8');
    } catch {
      return null;
    }

    const frontmatter = extractFrontmatter(content);
    // Files without frontmatter: generate collision-safe path-based anchor
    // Use full relative path (with / preserved as /) to avoid a-b/c vs a/b-c collisions
    const anchor =
      (frontmatter ? extractAnchor(frontmatter) : null) ??
      `doc:${relative(this.docsRoot, filePath).replace(/\.md$/, '')}`;

    const kind = frontmatter ? inferKind(frontmatter, filePath) : inferKindFromPath(filePath);
    const title = extractTitle(content);
    const summary = extractSummary(content);
    const sourceHash = createHash('sha256').update(content).digest('hex').slice(0, 16);

    const status = (
      frontmatter && typeof frontmatter.status === 'string' ? frontmatter.status : 'active'
    ) as EvidenceItem['status'];

    const item: EvidenceItem = {
      anchor,
      kind,
      status,
      title: title ?? anchor,
      updatedAt: new Date().toISOString(),
      sourcePath: relative(this.docsRoot, filePath),
    };
    if (summary) item.summary = summary;
    const topics = frontmatter?.topics;
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
  if (
    docKind === 'plan' ||
    filePath.includes('/plans/') ||
    filePath.includes('/phases/') ||
    filePath.includes('/guides/')
  )
    return 'plan';
  if (
    docKind === 'lesson' ||
    filePath.includes('/lessons/') ||
    filePath.includes('/reflections/') ||
    filePath.includes('/postmortems/') ||
    filePath.includes('/stories/')
  )
    return 'lesson';
  if (docKind === 'discussion' || filePath.includes('/discussions/')) return 'discussion';
  if (docKind === 'research' || filePath.includes('/research/')) return 'research';
  if (docKind === 'spec' || filePath.includes('/features/')) return 'feature';
  return 'plan'; // default for unknown docs
}

/** Infer kind from file path alone (no frontmatter available) */
function inferKindFromPath(filePath: string): EvidenceKind {
  for (const [dir, kind] of Object.entries(KIND_DIRS)) {
    if (filePath.includes(`/${dir}/`)) return kind;
  }
  return 'plan'; // default
}

function extractTitle(content: string): string | null {
  // First # heading after frontmatter
  const match = content.match(/^#\s+(.+)$/m);
  return match?.[1]?.trim() ?? null;
}

function extractSummary(content: string): string | null {
  // First meaningful paragraph after the title — skip blockquotes, status lines, and metadata
  const afterTitle = content.replace(/^---[\s\S]*?---\s*/, '').replace(/^#.*$/m, '');
  const paragraphs = afterTitle.split(/\n\n+/).filter((p) => {
    const t = p.trim();
    if (!t) return false;
    if (t.startsWith('#')) return false;
    if (t.startsWith('>')) return false; // blockquotes (often status lines)
    if (t.startsWith('|')) return false; // tables
    if (t.startsWith('```')) return false; // code blocks
    return true;
  });
  const first = paragraphs[0];
  if (!first) return null;
  const trimmed = first.trim().replace(/\n/g, ' ');
  return trimmed.length > 300 ? `${trimmed.slice(0, 297)}...` : trimmed;
}
