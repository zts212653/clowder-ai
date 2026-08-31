/**
 * F257 V1 — magic word 词面出现数 (T-B §3.5 of the F257 redesign).
 *
 * The metric is a READ-ONLY projection of Event Memory (single source of truth,
 * 归一裁定 2026-06-06) — this module writes NO second store. What it does write
 * is Event Memory itself, via the T-B collection-integrity contract: the live
 * path (`void tryDetectMagicWords`) can drop hits silently, so BEFORE computing
 * the metric we re-scan the window's user-authored messages with the same pure
 * detector and backfill missing events idempotently (markEvent is atomic on
 * UNIQUE(owner, threadId, messageId, word)). Reconcile failure → the window is
 * unmeasurable. A persisted owner-scoped high-watermark records scan progress.
 *
 * 口径 (T-B): raw substring hits, unique per (message, word) — NOT interpreted
 * as governance brakes; graded 拉闸数 is a future capability outside this module.
 */

import type { CatId, ConnectorSource, EventMemoryRecord } from '@cat-cafe/shared';
import type { RedisClient } from '@cat-cafe/shared/utils';
import {
  isAuthenticatedOperatorMessage,
  type MessageProvenance,
} from '../../../domains/cats/services/stores/ports/MessageStore.js';
import { parsePersistedMessageRecord } from '../../../domains/cats/services/stores/redis/redis-message-parsers.js';
import { MessageKeys } from '../../../domains/cats/services/stores/redis-keys/message-keys.js';
import type { IEventMemoryStore } from '../../../domains/memory/EventMemoryStore.js';
import { createModuleLogger } from '../../logger.js';
import { detectMagicWords, MAGIC_WORD_PATTERNS } from './magic-word-detector.js';

const log = createModuleLogger('magic-word-metric');

const MAGIC_WORD_WATERMARK_KEY = (ownerUserId: string) => `magic-word:reconcile-watermark:${ownerUserId}`;

/** Advance a numeric watermark only forward. */
const NUMERIC_WATERMARK_LUA = `
local cur = tonumber(redis.call('GET', KEYS[1]))
local nxt = tonumber(ARGV[1])
if (not cur) or (nxt > cur) then
  redis.call('SET', KEYS[1], ARGV[1])
  return 1
end
return 0
`;

const EXCERPT_MAX = 200;

export interface MagicWordReconcileResult {
  ok: boolean;
  /** user-authored messages scanned in the window */
  scanned: number;
  /** events newly inserted by this reconcile (live path had missed them) */
  backfilled: number;
}

export type MagicWordCountsResult =
  | { unmeasurable: true; reason: 'reconcile_failed' | 'read_failed' }
  | {
      unmeasurable: false;
      window: { fromTs: number; toTs: number };
      reconcile: MagicWordReconcileResult;
      /** unique (message, word) hit count per word — T-B raw口径 */
      counts: Record<string, number>;
      total: number;
    };

interface ScannableMessage {
  id: string;
  threadId: string;
  userId: string;
  from?: import('@cat-cafe/shared').MessageFrom;
  catId: CatId | null;
  content: string;
  mentions: readonly CatId[];
  effectiveOrderAt: number;
  source?: ConnectorSource;
  provenance?: MessageProvenance;
}

export class MagicWordMetricService {
  private readonly redis: RedisClient;
  private readonly eventMemoryStore: IEventMemoryStore;

  constructor(deps: { redis: RedisClient; eventMemoryStore: IEventMemoryStore }) {
    this.redis = deps.redis;
    this.eventMemoryStore = deps.eventMemoryStore;
  }

  private async readWindowMessages(ownerUserId: string, fromTs: number, toTs: number): Promise<ScannableMessage[]> {
    const entries = await this.redis.zrangebyscore(MessageKeys.user(ownerUserId), fromTs, toTs, 'WITHSCORES');
    if (entries.length === 0) return [];
    const candidates: Array<{ id: string; score: string }> = [];
    for (let index = 0; index + 1 < entries.length; index += 2) {
      candidates.push({ id: entries[index] as string, score: entries[index + 1] as string });
    }
    const pipeline = this.redis.pipeline();
    for (const candidate of candidates) {
      pipeline.hmget(
        MessageKeys.detail(candidate.id),
        'id',
        'threadId',
        'userId',
        'from',
        'catId',
        'content',
        'mentions',
        'timestamp',
        'deliveredAt',
        'deletedAt',
        'deletedBy',
        '_tombstone',
        'source',
        'routingFact',
        'provenance',
      );
    }
    const results = await pipeline.exec();
    if (!results || results.length !== candidates.length) {
      throw new Error('magic-word reconcile: pipeline result shape mismatch');
    }
    const messages: ScannableMessage[] = [];
    for (let index = 0; index < results.length; index += 1) {
      const entry = results[index];
      const candidate = candidates[index];
      const [err, value] = entry as [Error | null, Array<string | null>];
      if (err) throw err;
      const [
        id,
        threadId,
        userId,
        from,
        catId,
        content,
        mentions,
        timestamp,
        deliveredAt,
        deletedAt,
        deletedBy,
        tombstone,
        source,
        routingFact,
        provenance,
      ] = value;
      const parsed = parsePersistedMessageRecord({
        expectedId: candidate.id,
        expectedOwnerUserId: ownerUserId,
        expectedTimelineScore: candidate.score,
        id,
        threadId,
        userId,
        from,
        catId,
        content,
        mentions,
        timestamp,
        deliveredAt,
        deletedAt,
        deletedBy,
        tombstone,
        source,
        routingFact,
        provenance,
      });
      if (parsed.state === 'missing') {
        // sol R1 P1-4: an indexed message whose hash is gone is a collection
        // gap — skipping it silently would let the metric report a partial
        // window as fully reconciled.
        throw new Error('magic-word reconcile: indexed message hash missing');
      }
      if (parsed.state === 'invalid') {
        throw new Error(`magic-word reconcile: invalid persisted message record (${parsed.reason})`);
      }
      if (parsed.state === 'deleted') continue;
      const record = parsed.record;
      messages.push({
        id: record.id,
        threadId: record.threadId,
        userId: record.userId,
        ...(record.from ? { from: record.from } : {}),
        catId: record.catId,
        content: record.content,
        mentions: record.mentions,
        effectiveOrderAt: record.effectiveOrderAt,
        ...(record.source ? { source: record.source } : {}),
        ...(parsed.state === 'present' ? { provenance: parsed.provenance } : {}),
      });
    }
    return messages;
  }

  private backfillMessageHits(msg: ScannableMessage, ownerUserId: string): number {
    const hits = detectMagicWords(msg.content);
    if (hits.length === 0) return 0;
    const firstMention = msg.mentions[0] ?? null;
    const excerpt = msg.content.length > EXCERPT_MAX ? `${msg.content.slice(0, EXCERPT_MAX)}…` : msg.content;
    const seenWords = new Set<string>();
    let backfilled = 0;
    for (const hit of hits) {
      if (seenWords.has(hit.word)) continue; // unique per (message, word) — same as the store key
      seenWords.add(hit.word);
      const record: EventMemoryRecord = {
        type: hit.word,
        trigger: 'human_brake',
        cat: firstMention ?? 'unknown',
        threadId: msg.threadId,
        messageId: msg.id,
        // Same coordinate as owner timeline membership: queued messages move
        // to their delivery position while immediate messages stay at send time.
        timestamp: msg.effectiveOrderAt,
        summary: excerpt,
        cognitiveTransition: 'user_brake',
        relatedHarness: null,
        confidence: 'high',
      };
      const result = this.eventMemoryStore.markEvent(record, ownerUserId);
      if (result.inserted) backfilled += 1;
    }
    return backfilled;
  }

  /** Shared scan core — throws on any collection gap (callers map to ok:false). */
  private async scanAndBackfill(
    ownerUserId: string,
    fromTs: number,
    toTs: number,
  ): Promise<{ scanned: number; backfilled: number; userMessages: ScannableMessage[] }> {
    const messages = await this.readWindowMessages(ownerUserId, fromTs, toTs);
    let scanned = 0;
    let backfilled = 0;
    const userMessages: ScannableMessage[] = [];
    for (const msg of messages) {
      // T-B selects original observations on the AUTHOR axis: every real
      // operator-authored original counts whether or not it went through a
      // routing parser (e.g. game-lane user messages). Cat/system rows and
      // storage-derived branch/import copies do not create operator behavior
      // observations. Routing provenance remains a separate axis.
      // sol R4 P1-1c: 'absent' = legacy pre-contract message, honestly out of
      // cohort; 'malformed' = corrupt declaration, cohort membership unknowable
      // — a collection gap, so the window must read unmeasurable, not smaller.
      if (!isAuthenticatedOperatorMessage(msg)) {
        continue;
      }
      scanned += 1;
      userMessages.push(msg);
      backfilled += this.backfillMessageHits(msg, ownerUserId);
    }
    await this.redis.eval(NUMERIC_WATERMARK_LUA, 1, MAGIC_WORD_WATERMARK_KEY(ownerUserId), String(toTs));
    return { scanned, backfilled, userMessages };
  }

  /**
   * T-B collection-integrity contract: idempotently re-scan the window's
   * user-authored messages with the pure detector and backfill Event Memory.
   * Cat-authored messages are out of cohort (magic words are operator brakes).
   */
  async reconcileWindow(ownerUserId: string, fromTs: number, toTs: number): Promise<MagicWordReconcileResult> {
    try {
      const scan = await this.scanAndBackfill(ownerUserId, fromTs, toTs);
      return { ok: true, scanned: scan.scanned, backfilled: scan.backfilled };
    } catch (error) {
      log.error({ error, ownerUserId }, 'magic-word reconcile failed');
      return { ok: false, scanned: 0, backfilled: 0 };
    }
  }

  /**
   * T-B active-V1 metric: unique (message, word) hit counts per word over a
   * reconciled window — a read-only projection of Event Memory.
   *
   * sol R1/R7: window membership is a JOIN on message coordinates, never an
   * event-timestamp filter. Live events may land after an immediate message or
   * before a queued message's later delivery position, so either time-side
   * prefilter can drop a legitimate hit.
   */
  async computeWordCounts(ownerUserId: string, fromTs: number, toTs: number): Promise<MagicWordCountsResult> {
    let scan: { scanned: number; backfilled: number; userMessages: ScannableMessage[] };
    try {
      scan = await this.scanAndBackfill(ownerUserId, fromTs, toTs);
    } catch (error) {
      log.error({ error, ownerUserId }, 'magic-word reconcile failed');
      return { unmeasurable: true, reason: 'reconcile_failed' };
    }
    const reconcile: MagicWordReconcileResult = { ok: true, scanned: scan.scanned, backfilled: scan.backfilled };

    try {
      const magicWords = new Set<string>(MAGIC_WORD_PATTERNS);
      const counts: Record<string, number> = {};
      let total = 0;
      for (const msg of scan.userMessages) {
        const events = this.eventMemoryStore.getByCoord(msg.threadId, msg.id, ownerUserId);
        for (const event of events) {
          if (event.trigger !== 'human_brake') continue;
          if (!magicWords.has(event.type)) continue;
          counts[event.type] = (counts[event.type] ?? 0) + 1;
          total += 1;
        }
      }
      return { unmeasurable: false, window: { fromTs, toTs }, reconcile, counts, total };
    } catch (error) {
      log.error({ error, ownerUserId }, 'magic-word metric read failed');
      return { unmeasurable: true, reason: 'read_failed' };
    }
  }

  /** Collection-health snapshot: how far the reconcile watermark has advanced. */
  async getWatermark(ownerUserId: string): Promise<number | null> {
    try {
      const raw = await this.redis.get(MAGIC_WORD_WATERMARK_KEY(ownerUserId));
      return raw === null ? null : Number.parseInt(raw, 10);
    } catch (error) {
      log.error({ error, ownerUserId }, 'magic-word watermark read failed');
      return null;
    }
  }
}
