/**
 * ToolEventLog — F188 Phase F (AC-F10)
 *
 * Append-only Redis-backed event log per thread. Bypasses TranscriptWriter
 * toolName Set dedup (砚砚 F188 二审) and ToolUsageCounter (date, toolName)
 * aggregation — preserves full sequence for FM-1/FM-2/FM-5 computation.
 */

import type { RedisClient } from '@cat-cafe/shared/utils';
import { createModuleLogger } from '../../../../infrastructure/logger.js';
import { TOOL_EVENT_LOG_TTL_SECONDS, toolEventLogKey } from '../stores/redis-keys/tool-event-log-keys.js';
import type { NudgeFollowupAnalysis, ToolEvent } from './event-log-types.js';

const log = createModuleLogger('tool-event-log');

/** Tools that count as "nudge followed" — caller used the recommended entry. */
const NUDGE_FOLLOWUP_TOOLS = new Set(['graph_resolve', 'list_recent']);

/** Substrings that indicate a Bash grep / rg / find fallback. */
const GREP_FALLBACK_PATTERNS = ['grep', 'rg ', 'ripgrep', 'find ', 'find\t'];

export class ToolEventLog {
  /**
   * 砚砚 cloud-7 P1: per-thread serialization queue for updateSummary.
   * Without it, two concurrent fire-and-forget updateSummary calls for the
   * same thread both read the pre-merge zrange snapshot, both pick the same
   * "oldest unmerged" event, and patch into the same slot — second result
   * overwrites first, FIFO matching broken under parallel tool_result delivery.
   */
  private readonly updateChain = new Map<string, Promise<unknown>>();

  constructor(private readonly redis: RedisClient) {}

  /** Append a tool event. Errors logged, never thrown.
   *
   * 砚砚 四审 P1-4: stable sequence — score combines per-thread INCR sequenceId
   * with timestamp tie-breaker so same-ms multi-events keep insertion order.
   * Falls back to timestamp-only if INCR unavailable (e.g. fake Redis).
   */
  async append(event: ToolEvent): Promise<void> {
    const key = toolEventLogKey(event.threadId);
    const seqKey = `${key}:seq`;
    let seq: number | null = null;
    try {
      const r = this.redis as { incr?: (k: string) => Promise<number> };
      if (r.incr) seq = await r.incr(seqKey);
    } catch {
      seq = null;
    }
    // Score = sequenceId (10 digits) gives strict monotonicity within a thread.
    // Same-timestamp tie? sequenceId increments — order preserved.
    // Fallback (no INCR): timestamp + turnIndex * 1e-6 (turnIndex tie-break).
    const score = seq != null ? seq : event.timestamp + (event.turnIndex ?? 0) * 1e-6;
    const member = JSON.stringify(event);

    try {
      const added = await this.redis.zadd(key, score, member);
      if (added > 0) {
        await this.redis.expire(key, TOOL_EVENT_LOG_TTL_SECONDS).catch(noop);
        // Side TTL on seq counter so it doesn't leak forever
        const r = this.redis as { expire?: (k: string, ttl: number) => Promise<number> };
        await r.expire?.(seqKey, TOOL_EVENT_LOG_TTL_SECONDS).catch(noop);
      }
    } catch (err) {
      log.warn({ err, key, toolName: event.toolName }, 'Failed to append tool event');
    }
  }

  /** Read all events for a thread, ordered by timestamp ascending. */
  async readByThread(threadId: string): Promise<ToolEvent[]> {
    const key = toolEventLogKey(threadId);
    const members = await this.redis.zrange(key, 0, -1);
    return members.map((m) => JSON.parse(m) as ToolEvent);
  }

  /**
   * 砚砚 六审 P1-A: discover thread IDs that own a tool-event-log zset.
   * Handles ioredis keyPrefix manually (keys()/scan() don't auto-prefix per
   * RedisGameStore convention) and filters out the `:seq` counter sibling
   * key so callers don't accidentally zrange a string and hit WRONGTYPE.
   *
   * 砚砚 cloud-5 P1: uses cursor-based SCAN instead of blocking KEYS. KEYS
   * is O(N) blocking — on a production-sized keyspace it pauses Redis event
   * processing and degrades unrelated API traffic. This endpoint is wired
   * to interactive Memory Health Dashboard fetches, so we must not stall
   * the server. Falls back to keys() only for test fakes that lack scan.
   */
  async listThreadIds(): Promise<string[]> {
    const r = this.redis as unknown as {
      options?: { keyPrefix?: string };
      scan?: (cursor: string, ...args: (string | number)[]) => Promise<[string, string[]]>;
      keys?: (p: string) => Promise<string[]>;
    };
    const keyPrefix = r.options?.keyPrefix ?? '';
    const pattern = `${keyPrefix}tool-event-log:*`;
    const collected: string[] = [];
    if (r.scan) {
      // Cursor-based SCAN with MATCH/COUNT. ioredis returns `[cursor, keys]`.
      let cursor = '0';
      let guard = 0; // bounded loop to prevent runaway scan in misbehaving redis
      do {
        const result = await r
          .scan(cursor, 'MATCH', pattern, 'COUNT', 200)
          .catch(() => ['0', [] as string[]] as [string, string[]]);
        cursor = result[0];
        for (const k of result[1]) collected.push(k);
        if (++guard > 10_000) break;
      } while (cursor !== '0');
    } else if (r.keys) {
      // Fallback for test fakes / older redis client shims.
      const fallback = await r.keys(pattern).catch(() => [] as string[]);
      for (const k of fallback) collected.push(k);
    } else {
      return [];
    }
    // 砚砚 cloud-6 P2: dedupe via Set. Redis SCAN may return duplicate keys
    // across cursor iterations (documented behavior); without dedup, the same
    // thread would be processed multiple times by the aggregator and inflate
    // counts/rates for FM-1/FM-3/FM-5.
    const threadIdSet = new Set<string>();
    for (const raw of collected) {
      // Strip optional keyPrefix back off
      const k = keyPrefix && raw.startsWith(keyPrefix) ? raw.slice(keyPrefix.length) : raw;
      // Filter sibling counter `tool-event-log:{threadId}:seq` keys (string, not zset)
      if (k.endsWith(':seq')) continue;
      const m = /^tool-event-log:(.+)$/.exec(k);
      if (m?.[1]) threadIdSet.add(m[1]);
    }
    return [...threadIdSet];
  }

  /**
   * Update an existing event's summary fields (砚砚 三审 P1-1: result-side data
   * arrives in tool_result message AFTER tool_use; merge it back so aggregator
   * can compute FM-2/FM-5 from real result data).
   *
   * Match precedence:
   *   1. `matcher.toolUseId` (exact, forward-compat when providers emit it)
   *   2. Otherwise: oldest unmatched event with matching toolName + catId
   *      (FIFO — 砚砚 cloud P1: prevents parallel-tool-call pollution where
   *      late result was overwriting earlier call's merge slot)
   *
   * `_resultMerged=true` sentinel marks merged events so subsequent results
   * walk past them and find the next unmatched call (oldest-first).
   *
   * O(N) read+rewrite per call; for v1 thread sizes (~tens of events) this is
   * fine. Will need a secondary index for larger threads.
   */
  async updateSummary(
    threadId: string,
    matcher: { toolUseId?: string; toolName?: string; catId?: string },
    summaryPatch: Record<string, unknown>,
  ): Promise<boolean> {
    // 砚砚 cloud-7 P1: chain per-thread updates so concurrent fire-and-forget
    // calls don't race on the same zrange snapshot. Even when callers do
    // `.catch(() => {})` (no await), serialization happens inside ToolEventLog.
    const prev = this.updateChain.get(threadId) ?? Promise.resolve();
    const next = prev.then(
      () => this._doUpdateSummary(threadId, matcher, summaryPatch),
      () => this._doUpdateSummary(threadId, matcher, summaryPatch),
    );
    this.updateChain.set(threadId, next);
    try {
      return await next;
    } finally {
      // GC: only delete if our promise is still the tail (otherwise a later
      // call has already chained behind us and is the new tail).
      if (this.updateChain.get(threadId) === next) {
        this.updateChain.delete(threadId);
      }
    }
  }

  private async _doUpdateSummary(
    threadId: string,
    matcher: { toolUseId?: string; toolName?: string; catId?: string },
    summaryPatch: Record<string, unknown>,
  ): Promise<boolean> {
    const key = toolEventLogKey(threadId);
    // 砚砚 五审 P1-B: preserve original zset score (append uses INCR sequence,
    // not timestamp). zrange WITHSCORES gets us [member, score, member, score...]
    const r = this.redis as {
      zrange: (key: string, start: number, stop: number, opt?: string) => Promise<string[]>;
      zadd: (key: string, score: number, member: string) => Promise<number>;
      zrem?: (k: string, m: string) => Promise<number>;
    };
    const withScores = await r.zrange(key, 0, -1, 'WITHSCORES').catch(() => [] as string[]);
    // withScores layout: [member0, score0, member1, score1, ...]
    // 砚砚 cloud-6 P2: parity-only detection misparsed shims that ignore
    // WITHSCORES and return only members in even count. Also verify that
    // every odd-indexed slot is a parseable number — that's the score-tuple
    // signature ioredis guarantees. Wrong shape → drop half the events and
    // merge into wrong record. Strict check protects telemetry integrity.
    const hasScores = (() => {
      if (withScores.length < 2 || withScores.length % 2 !== 0) return false;
      for (let i = 1; i < withScores.length; i += 2) {
        if (Number.isNaN(Number.parseFloat(withScores[i]!))) return false;
      }
      return true;
    })();
    const pairs: Array<{ member: string; score: number }> = [];
    if (hasScores) {
      for (let i = 0; i < withScores.length; i += 2) {
        pairs.push({ member: withScores[i]!, score: Number.parseFloat(withScores[i + 1]!) });
      }
    } else {
      // Fallback: no scores returned — use insertion order, no real score preservation
      const members = await this.redis.zrange(key, 0, -1);
      for (const m of members) pairs.push({ member: m, score: Number.NaN });
    }
    // Walk oldest → newest. With toolUseId, exact match wins anywhere; without,
    // first matching toolName+catId event that hasn't been merged yet (FIFO).
    let updated = false;
    for (let i = 0; i < pairs.length; i++) {
      const pair = pairs[i];
      if (!pair) continue;
      const event = JSON.parse(pair.member) as ToolEvent & { summary?: Record<string, unknown> };
      const summary = event.summary ?? {};
      if (matcher.toolUseId) {
        if (summary['_toolUseId'] !== matcher.toolUseId) continue;
      } else {
        if (matcher.toolName && event.toolName !== matcher.toolName) continue;
        // 砚砚 六审 P1-B: also require catId match when supplied (parallel-cat guard)
        if (matcher.catId && event.catId !== matcher.catId) continue;
        // 砚砚 cloud P1: skip already-merged events so subsequent results don't
        // overwrite an earlier call's data — FIFO match to next unmatched call.
        if (summary['_resultMerged'] === true) continue;
      }
      const mergedSummary = { ...summary, ...summaryPatch, _resultMerged: true };
      const newEvent = { ...event, summary: mergedSummary };
      const newMember = JSON.stringify(newEvent);
      // 砚砚 cloud-4 P2: idempotent retry guard — when newMember bytes match
      // pair.member (same patch re-applied), zadd would be a no-op and the
      // subsequent zrem would delete the only copy, corrupting telemetry.
      // Short-circuit instead.
      if (newMember === pair.member) {
        updated = true;
        break;
      }
      try {
        // Insert new member with PRESERVED original score (砚砚 五审 P1-B).
        // Fallback path: if score was NaN, use event.timestamp as least-bad approximation.
        const preservedScore = Number.isNaN(pair.score) ? event.timestamp : pair.score;
        await this.redis.zadd(key, preservedScore, newMember);
        if (r.zrem) await r.zrem(key, pair.member).catch(() => {});
      } catch (err) {
        log.warn({ err, key, threadId }, 'Failed to update event summary');
        return false;
      }
      updated = true;
      break;
    }
    return updated;
  }

  /**
   * Get all event sub-sequences immediately following calls to `toolName`.
   * For each occurrence of `toolName`, returns up to `maxTurns` subsequent events.
   *
   * Used by FM-1 (grep_after_search_rate): pass toolName='search_evidence',
   * then count sequences containing a Bash grep.
   */
  async getAllSequencesAfterTool(threadId: string, toolName: string, maxTurns: number): Promise<ToolEvent[][]> {
    const events = await this.readByThread(threadId);
    const sequences: ToolEvent[][] = [];
    events.forEach((event, idx) => {
      if (event.toolName !== toolName) return;
      // 砚砚 cloud-8 P1: window counts maxTurns SAME-CAT events, not raw-timeline
      // events filtered to same-cat. Otherwise interleaved other-cat events
      // consume the window and hide same-cat follow-ups that actually occurred
      // within the next maxTurns of A's events — FM-1 grep_after_search_rate
      // would systematically undercount in concurrent conversations.
      const seq: ToolEvent[] = [];
      for (let j = idx + 1; j < events.length && seq.length < maxTurns; j++) {
        const e = events[j]!;
        if (e.catId === event.catId) seq.push(e);
      }
      sequences.push(seq);
    });
    return sequences;
  }

  /**
   * Analyze nudge followup for all search_evidence events with nudgeEmitted=true.
   * For each, check whether the next N turns contain graph_resolve/list_recent
   * (nudgeFollowed=true) or a Bash grep fallback (fallbackGrepDetected=true).
   *
   * Supports FM-5 (nudge effectiveness): nudge truly failed iff
   * followed=false AND fallbackGrepDetected=true. 4.6 review #4 修正 —
   * "未试" 单独不算失效, 必须叠加 grep fallback 排除 confound.
   */
  async analyzeNudgeFollowup(threadId: string, lookaheadTurns: number): Promise<NudgeFollowupAnalysis[]> {
    const events = await this.readByThread(threadId);
    const result: NudgeFollowupAnalysis[] = [];
    events.forEach((event, idx) => {
      if (event.toolName !== 'search_evidence') return;
      const summary = event.summary as { nudgeEmitted?: boolean };
      if (!summary?.nudgeEmitted) return;

      // 砚砚 cloud-8 P1: window counts lookaheadTurns SAME-CAT events, not
      // raw-timeline events filtered to same-cat. Pre-fix, interleaved other-
      // cat events could consume the window and hide A's actual follow-up that
      // happened within A's next N turns — FM-5 nudge-failure would be biased
      // downward in concurrent conversations.
      const lookahead: ToolEvent[] = [];
      for (let j = idx + 1; j < events.length && lookahead.length < lookaheadTurns; j++) {
        const e = events[j]!;
        if (e.catId === event.catId) lookahead.push(e);
      }
      const followupTool = lookahead.find((e) => NUDGE_FOLLOWUP_TOOLS.has(e.toolName));
      const grepEvent = lookahead.find((e) => isGrepFallback(e));

      result.push({
        searchEvent: event,
        followed: Boolean(followupTool),
        followupTool: followupTool?.toolName ?? null,
        fallbackGrepDetected: Boolean(grepEvent),
      });
    });
    return result;
  }
}

function isGrepFallback(event: ToolEvent): boolean {
  if (event.toolName !== 'Bash') return false;
  const summary = event.summary as { command?: unknown };
  if (typeof summary?.command !== 'string') return false;
  const lower = summary.command.toLowerCase();
  return GREP_FALLBACK_PATTERNS.some((p) => lower.includes(p));
}

function noop(): void {}
