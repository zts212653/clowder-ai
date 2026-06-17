/**
 * F227 PR-2 Task 6 — historical magic-word backfill.
 *
 * Scans the persisted message corpus → graded detector (Task 5) →
 * EventMemoryStore.markEvent. Produces the SAME terminal 10-field records as the
 * PR-1 live `onMagicWordDetected` path, except:
 *   - confidence is GRADED (live is always high; backfill must filter the SNR-22% noise)
 *   - timestamp / coords come from the historical message
 *   - cognitiveTransition is null for low-confidence (a mention, not a real transition)
 *
 * Idempotent: the store's UNIQUE(ownerUserId, threadId, messageId, type) guard dedups, so
 * it is safe to re-run AND safe against overlap with PR-1 live writes. Failures dead-letter
 * (最终不丢, LL-048). Resumable: the caller paginates; runCorpusBackfill walks
 * threads + messages in batches.
 */

import type { EventConfidence, EventMemoryRecord } from '@cat-cafe/shared';
import type { IEventMemoryStore } from './EventMemoryStore.js';
import { detectGradedMagicWords } from './magic-word-confidence.js';

/** The minimal slice of a StoredMessage the backfill reads. */
export interface StoredMessageLike {
  id: string;
  threadId: string;
  content: string;
  timestamp: number;
  /** null = user (co-creator) message; a CatId = cat message. */
  catId: string | null;
  /**
   * Message author's userId. Backfill only marks the OWNER's own rows: getByThreadAfter
   * also returns globally-visible SYSTEM messages (isSystemUserMessage), which must NOT be
   * copied into a user's Event Memory as a human brake (cloud-review P1).
   */
  userId?: string;
  mentions?: readonly string[];
  extra?: { targetCats?: string[] } | undefined;
}

/** Normalized message the grader/record-builder consume. */
export interface BackfillMessage {
  messageId: string;
  threadId: string;
  content: string;
  timestamp: number;
  authoredByCocreator: boolean;
  /** 当事猫 (the braked cat) — first explicit target, else first mention, else null. */
  targetCat: string | null;
}

/** Only the store surface the backfill touches (keeps it test-stubbable). */
type BackfillStore = Pick<IEventMemoryStore, 'markEvent' | 'appendDeadLetter'>;

export interface BackfillResult {
  scanned: number;
  marked: number;
  skipped: number;
  failed: number;
}

const MAX_SUMMARY = 200;

function excerpt(text: string): string {
  return text.length > MAX_SUMMARY ? `${text.slice(0, MAX_SUMMARY)}…` : text;
}

/** Extract the backfill fields from a stored message (author + target + coords). */
export function extractBackfillMessage(m: StoredMessageLike): BackfillMessage {
  return {
    messageId: m.id,
    threadId: m.threadId,
    content: m.content,
    timestamp: m.timestamp,
    authoredByCocreator: m.catId === null,
    targetCat: m.extra?.targetCats?.[0] ?? m.mentions?.[0] ?? null,
  };
}

/** Build the terminal 10-field record for one graded hit (mirrors the live path). */
export function buildBackfillEvent(
  msg: BackfillMessage,
  hit: { word: string; confidence: EventConfidence },
): EventMemoryRecord {
  return {
    type: hit.word,
    trigger: 'human_brake',
    cat: msg.targetCat ?? 'unknown',
    threadId: msg.threadId,
    messageId: msg.messageId,
    timestamp: msg.timestamp,
    summary: excerpt(msg.content),
    cognitiveTransition: hit.confidence === 'low' ? null : 'user_brake',
    relatedHarness: null,
    confidence: hit.confidence,
  };
}

/** Process a batch of already-extracted messages into graded events (idempotent). */
export function backfillMagicWordEvents(
  messages: Iterable<BackfillMessage>,
  store: BackfillStore,
  ownerUserId: string,
): BackfillResult {
  const result: BackfillResult = { scanned: 0, marked: 0, skipped: 0, failed: 0 };
  for (const msg of messages) {
    result.scanned += 1;
    const hits = detectGradedMagicWords(msg.content, { authoredByCocreator: msg.authoredByCocreator });
    if (hits.length === 0) continue;
    for (const hit of hits) {
      const record = buildBackfillEvent(msg, hit);
      try {
        // Idempotency is the store's job now (UNIQUE owner+coord+type): a re-run, a repeated
        // word in one message, or a race with a live write all resolve to inserted=false —
        // no getByCoord check-then-act (cloud-review P1). ownerUserId scopes the write.
        const { inserted } = store.markEvent(record, ownerUserId);
        if (inserted) result.marked += 1;
        else result.skipped += 1;
      } catch (err) {
        store.appendDeadLetter(record, ownerUserId, String(err));
        result.failed += 1;
      }
    }
  }
  return result;
}

/** Thread listing source (subset of IThreadStore). */
export interface BackfillThreadSource {
  list(userId: string): { id: string }[] | Promise<{ id: string }[]>;
}

/** Per-thread message source (structural subset of IMessageStore — all params optional). */
export interface BackfillMessageSource {
  getByThreadAfter(
    threadId: string,
    afterId?: string,
    limit?: number,
    userId?: string,
  ): StoredMessageLike[] | Promise<StoredMessageLike[]>;
}

export interface RunCorpusBackfillOptions {
  userId: string;
}

/**
 * Walk every thread for a user and backfill graded magic-word events.
 *
 * Each thread is loaded WHOLE (one getByThreadAfter, owner-scoped by userId, no limit),
 * deliberately not paginated: RedisMessageStore.getByThreadAfter applies `limit` to the
 * raw Redis id range BEFORE its isDelivered/userId filters, so a short/empty filtered
 * page does NOT mean the thread is exhausted — paging on page length silently drops older
 * events (cloud-review P2 + LL feedback_inmemory_store_tests_miss_redis_behavior). userId
 * IS passed (cloud-review P1): ThreadStore.list always includes the SHARED default thread,
 * so an unscoped scan would persist other users' events. Idempotent via the store's atomic
 * UNIQUE(ownerUserId, threadId, messageId, type) guard.
 */
export async function runCorpusBackfill(
  threadSource: BackfillThreadSource,
  messageSource: BackfillMessageSource,
  store: BackfillStore,
  opts: RunCorpusBackfillOptions,
): Promise<BackfillResult> {
  const total: BackfillResult = { scanned: 0, marked: 0, skipped: 0, failed: 0 };
  const threads = await threadSource.list(opts.userId);
  for (const thread of threads) {
    // Unbounded `limit` (filtered page length is not a reliable "exhausted" signal — see
    // above) but DO pass userId: ThreadStore.list always includes the SHARED default
    // thread, so omitting the owner filter would scan other users' messages into the
    // global EventMemoryStore (cloud-review P1).
    const messages = await messageSource.getByThreadAfter(thread.id, undefined, undefined, opts.userId);
    // getByThreadAfter(userId) ALSO returns globally-visible SYSTEM messages
    // (isSystemUserMessage). Only mark the OWNER's OWN rows — else a system message quoting
    // a magic word would be persisted into every backfilling user's timeline as a human
    // brake (cloud-review P1). System / non-owner rows are skipped.
    const owned = messages.filter((m) => m.userId === opts.userId);
    if (owned.length === 0) continue;
    const res = backfillMagicWordEvents(owned.map(extractBackfillMessage), store, opts.userId);
    total.scanned += res.scanned;
    total.marked += res.marked;
    total.skipped += res.skipped;
    total.failed += res.failed;
  }
  return total;
}
