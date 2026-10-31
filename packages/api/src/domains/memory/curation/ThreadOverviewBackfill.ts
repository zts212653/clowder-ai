import { compareCursors, cursorFor, parseCursor } from '../../cats/services/stores/cursor.js';
import { canAccessThread } from '../../guides/guide-state-access.js';
import { toAbstractiveMessages } from '../abstractive-summary-input.js';
import type {
  AbstractiveInput,
  AbstractiveResult,
  SummaryAttempt,
  SummaryGenerationUsage,
} from '../abstractive-summary-types.js';
import {
  commitSummaryProjection,
  countCoveredSummaryMessages,
  readRecallSuppressionFence,
} from '../summary-compaction-effects.js';
import { planHistoricalSummaryInputSettlement, type SummaryReadBatch } from '../summary-input-batch.js';
import { settleSkippedSummaryInput } from '../summary-skipped-input.js';
import { isCurationMessageReadable } from './curation-message-visibility.js';
import { overviewRevision, overviewSourceIds } from './LunaCurationState.js';
import type { ThreadOverviewRepository } from './ThreadOverviewRepository.js';

interface BackfillState {
  threadId: string;
  cursor: string | null;
  target: string | null;
}
/** Cursor belongs to summary storage, not a second memory corpus. Each tick is resumable. */
export class ThreadOverviewBackfill {
  constructor(
    private readonly deps: {
      repository: ThreadOverviewRepository;
      generate: (
        input: AbstractiveInput,
        signal?: AbortSignal,
        onUsage?: (usage: SummaryGenerationUsage) => void,
      ) => Promise<AbstractiveResult | null>;
      onAttempt?: (attempt: SummaryAttempt) => Promise<void>;
      liveSinceMs?: () => number | null;
      runExclusive?: <T>(fn: () => T) => Promise<T>;
    },
  ) {}

  async initialize(onlyThreadId?: string): Promise<BackfillState[]> {
    const { db, ownerUserId, threadStore, messageStore } = this.deps.repository.deps;
    const single = onlyThreadId ? await threadStore.get(onlyThreadId) : null;
    const threads = onlyThreadId ? (single ? [single] : []) : await threadStore.list(ownerUserId);
    const readableIds = new Set<string>();
    for (const thread of threads) {
      if (!canAccessThread(thread, ownerUserId) || thread.deletedAt || thread.systemKind) continue;
      readableIds.add(thread.id);
      if (
        db
          .prepare('SELECT 1 FROM thread_curation_state WHERE owner_user_id=? AND thread_id=?')
          .get(ownerUserId, thread.id)
      )
        continue;
      const latest = await messageStore.getLatestVisibleCursor(thread.id, { viewerUserId: ownerUserId });
      const row = db.prepare('SELECT summary FROM evidence_docs WHERE anchor=?').get(`thread-${thread.id}`) as
        | { summary: string | null }
        | undefined;
      db.prepare(`INSERT OR IGNORE INTO thread_curation_state
        (owner_user_id,thread_id,session_id,provider_identity,summary_revision,directory_line,backfill_target,backfill_complete)
        VALUES (?,?,NULL,'initializing',?,'',?,?)`).run(
        ownerUserId,
        thread.id,
        overviewRevision(row?.summary ?? null),
        latest?.cursor ?? null,
        !latest || (this.deps.liveSinceMs?.() != null && thread.createdAt >= this.deps.liveSinceMs()!) ? 1 : 0,
      );
    }
    const pending = db
      .prepare(`SELECT thread_id AS threadId,backfill_cursor AS cursor,backfill_target AS target
      FROM thread_curation_state WHERE owner_user_id=? AND backfill_complete=0
      ORDER BY backfill_attempt_order,thread_id`)
      .all(ownerUserId) as BackfillState[];
    // Canonical thread visibility pauses work; retain its cursor/session for a later restore.
    return pending.filter((state) => readableIds.has(state.threadId)).slice(0, 3);
  }

  async process(state: BackfillState, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const { db, ownerUserId } = this.deps.repository.deps;
    const thread = await this.deps.repository.deps.threadStore.get(state.threadId);
    if (!thread || !canAccessThread(thread, ownerUserId) || thread.deletedAt || thread.systemKind) return false;
    signal?.throwIfAborted();
    // Persist the rotation before I/O: rejection, timeout or a process crash still gives later threads a turn.
    const attempted = db
      .prepare(`UPDATE thread_curation_state SET backfill_attempt_order=
      (SELECT COALESCE(MAX(backfill_attempt_order),0)+1 FROM thread_curation_state WHERE owner_user_id=?)
      WHERE owner_user_id=? AND thread_id=? AND backfill_complete=0 AND backfill_cursor IS ?`)
      .run(ownerUserId, ownerUserId, state.threadId, state.cursor);
    if (!attempted.changes) return false;
    let usage: SummaryGenerationUsage | undefined;
    let success = false;
    try {
      success = await this.processBatch(state, signal, (value) => {
        usage = value;
      });
      return success;
    } finally {
      if (usage) await this.deps.onAttempt?.({ ...usage, success }).catch(() => {});
    }
  }

  private async processBatch(
    state: BackfillState,
    signal: AbortSignal | undefined,
    onUsage: (usage: SummaryGenerationUsage) => void,
  ) {
    const { db, ownerUserId, messageStore, threadStore } = this.deps.repository.deps;
    const thread = await threadStore.get(state.threadId);
    if (!thread || !canAccessThread(thread, ownerUserId) || thread.deletedAt || thread.systemKind) return false;
    const fence = readRecallSuppressionFence(db, state.threadId);
    if (fence.preparedCount) return false;
    const row = db.prepare('SELECT summary FROM evidence_docs WHERE anchor=?').get(`thread-${state.threadId}`) as
      | { summary: string | null }
      | undefined;
    const waterAtRead =
      (
        db
          .prepare('SELECT last_summarized_message_id AS id FROM summary_state WHERE thread_id=?')
          .get(state.threadId) as { id: string | null } | undefined
      )?.id ?? null;
    const canonicalize = async (cursor: string | null) => {
      if (!cursor || parseCursor(cursor)?.version === 2) return cursor;
      const result = await messageStore.canonicalizeCursor?.(cursor, state.threadId);
      if (parseCursor(result)?.version !== 2) throw new Error('historical_summary_position_unresolved');
      return result!;
    };
    const [target, canonicalWatermark] = await Promise.all([canonicalize(state.target), canonicalize(waterAtRead)]);
    // If scanner coverage is missing, the initializer creates its canonical thread row here.
    if (!row)
      db.prepare(`INSERT OR IGNORE INTO evidence_docs(anchor,kind,status,title,summary,updated_at)
      VALUES (?,'thread','active',?,NULL,?)`).run(
        `thread-${state.threadId}`,
        thread.title || state.threadId,
        new Date().toISOString(),
      );
    const page = await messageStore.getByThreadAfter(state.threadId, state.cursor ?? undefined, 200, undefined, {
      unresolvedCursorPolicy: 'empty',
      includeQueuedCatMessages: true,
      includeRecalledUserMessages: true,
    });
    const scanned = page.filter((m) => !target || compareCursors(cursorFor(m), target) <= 0);
    const reachesTarget = Boolean(target && page.some((m) => compareCursors(cursorFor(m), target) >= 0));
    const batch: SummaryReadBatch = {
      messages: [],
      scanIncomplete: page.length === 200 && !reachesTarget,
      scannedMessages: scanned.map((m) => ({
        id: m.id,
        cursor: cursorFor(m),
        tokenCount: Math.ceil(m.content.length / 4),
      })),
    };
    const material = scanned.filter((m) => isCurationMessageReadable(m, ownerUserId, state.threadId));
    const readableThread = await threadStore.get(state.threadId);
    if (
      !readableThread ||
      !canAccessThread(readableThread, ownerUserId) ||
      readableThread.deletedAt ||
      readableThread.systemKind
    )
      return false;
    const previousSummary = row?.summary ?? null;
    if (!material.length) {
      const cursor = scanned.length ? cursorFor(scanned.at(-1)!) : state.cursor;
      signal?.throwIfAborted();
      const commit = () =>
        db
          .transaction(() => {
            signal?.throwIfAborted();
            const live = readRecallSuppressionFence(db, state.threadId);
            if (live.preparedCount || live.committedEpoch !== fence.committedEpoch) return false;
            const previous = db
              .prepare('SELECT last_summarized_message_id AS id FROM summary_state WHERE thread_id=?')
              .get(state.threadId) as { id: string | null } | undefined;
            if (previous && previous.id !== waterAtRead) return false;
            const updated = db
              .prepare(`UPDATE thread_curation_state SET backfill_cursor=?,backfill_complete=?
        WHERE owner_user_id=? AND thread_id=? AND backfill_cursor IS ?`)
              .run(cursor, page.length < 200 || reachesTarget ? 1 : 0, ownerUserId, state.threadId, state.cursor);
            if (!updated.changes) return false;
            const settlement =
              previous && planHistoricalSummaryInputSettlement(batch, 0, previous.id, canonicalWatermark);
            if (settlement && !settleSkippedSummaryInput(db, state.threadId, settlement, fence))
              throw new Error('historical_input_settlement_failed');
            return true;
          })
          .immediate();
      return this.deps.runExclusive ? await this.deps.runExclusive(commit) : commit();
    }
    const inputMessages = await toAbstractiveMessages(material, messageStore);
    batch.messages = inputMessages;
    const result = await this.deps.generate(
      { threadId: state.threadId, previousSummary, messages: inputMessages },
      signal,
      onUsage,
    );
    signal?.throwIfAborted();
    if (!result) return false;
    const covered = countCoveredSummaryMessages(inputMessages, result);
    if (!covered) return false;
    const lastId = inputMessages[covered - 1]?.id;
    if (!lastId) return false;
    const acknowledged = planHistoricalSummaryInputSettlement(batch, covered, null);
    if (!acknowledged) return false;
    const scanEnd = acknowledged.lastMessageId;
    const ids = overviewSourceIds(result.segments.map((s) => s.summary).join('\n'), state.threadId);
    if (!(await Promise.all(ids.map((id) => this.deps.repository.isSourceReadable(state.threadId, id)))).every(Boolean))
      return false;
    const currentThread = await threadStore.get(state.threadId);
    if (
      !currentThread ||
      !canAccessThread(currentThread, ownerUserId) ||
      currentThread.deletedAt ||
      currentThread.systemKind
    )
      return false;
    const complete = covered === inputMessages.length && (page.length < 200 || reachesTarget);
    const commit = () =>
      db
        .transaction(() => {
          signal?.throwIfAborted();
          const current = db
            .prepare('SELECT summary FROM evidence_docs WHERE anchor=?')
            .get(`thread-${state.threadId}`) as { summary: string | null };
          const live = readRecallSuppressionFence(db, state.threadId);
          if (live.preparedCount || live.committedEpoch !== fence.committedEpoch || current.summary !== previousSummary)
            return false;
          const previousWatermark =
            (
              db
                .prepare('SELECT last_summarized_message_id AS id FROM summary_state WHERE thread_id=?')
                .get(state.threadId) as { id: string | null } | undefined
            )?.id ?? null;
          if (previousWatermark !== waterAtRead) return false;
          const updated = db
            .prepare(`UPDATE thread_curation_state SET backfill_cursor=?,backfill_complete=?
        WHERE owner_user_id=? AND thread_id=? AND backfill_cursor IS ?`)
            .run(scanEnd, complete ? 1 : 0, ownerUserId, state.threadId, state.cursor);
          if (!updated.changes) return false;
          db.prepare('INSERT OR IGNORE INTO summary_state(thread_id) VALUES (?)').run(state.threadId);
          const settlement = planHistoricalSummaryInputSettlement(
            batch,
            covered,
            previousWatermark,
            canonicalWatermark,
          );
          const watermark =
            canonicalWatermark && compareCursors(canonicalWatermark, scanEnd) > 0 ? canonicalWatermark : scanEnd;
          const summary = result.segments.map((s) => s.summary).join('\n\n');
          const committed = commitSummaryProjection(
            { db },
            {
              threadId: state.threadId,
              lastMessageId: watermark,
              ...(settlement ? { settlement } : {}),
              result,
              now: new Date().toISOString(),
              mergedSummary: summary,
              totalTokens: summary.length / 4,
              suppressionFence: fence,
              expectedSummary: previousSummary,
              processedMessages: [],
              pendingMessages: [],
            },
          );
          if (!committed) throw new Error('historical_overview_commit_failed');
          return true;
        })
        .immediate();
    return this.deps.runExclusive ? await this.deps.runExclusive(commit) : commit();
  }
}
