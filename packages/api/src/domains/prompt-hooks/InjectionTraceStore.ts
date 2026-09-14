/**
 * InjectionTraceStore — F237 (Trace v0)
 *
 * Dual-layer Redis persistence for prompt injection traces:
 *   Layer 1: InjectionTraceSummary — persistent (TTL=0)
 *   Layer 2: InjectionTraceDetail — short TTL (default 7 days)
 */

import type {
  EvaluationUnitRef,
  InjectionTraceDetail,
  InjectionTraceSummary,
  ReplaySnapshot,
  TraceEpisode,
  TraceTerminalExtension,
} from '@cat-cafe/shared';
import type { RedisClient } from '@cat-cafe/shared/utils';

const SUMMARY_PREFIX = 'injection-trace-summary:';
const DETAIL_PREFIX = 'injection-trace-detail:';
const INDEX_PREFIX = 'injection-trace-index:';
const REPLAY_SNAPSHOT_PREFIX = 'replay-snapshot:';
const TERMINAL_BY_INVOCATION_PREFIX = 'trace-terminal-by-invocation:';
const UNCLASSIFIED_EPISODE_PREFIX = 'trace-unclassified-episode:';
const UNCLASSIFIED_OWNER_REGISTRY_KEY = 'trace-unclassified-owner-registry';
const OWNER_EPISODE_PREFIX = 'trace-owner-episode:';
const OWNER_EPISODE_BACKFILL_DONE_KEY = 'trace-owner-episode-backfill-done';
/**
 * F257 Phase D: Registry of thread IDs with trace data.
 * Uses a Redis SET (SADD/SMEMBERS) instead of SCAN because ioredis keyPrefix
 * does NOT apply to SCAN MATCH patterns — SADD/SMEMBERS respect keyPrefix.
 * Populated on every persist() call; read by listTracedThreadIds().
 */
const THREAD_REGISTRY_KEY = 'injection-trace-thread-registry';
/**
 * Durable marker: set to '1' after the one-time backfill SCAN succeeds.
 * Decoupled from registry contents — new persist() SADDs don't prevent
 * legacy threads from being discovered (terra review P1, 2026-07-14).
 */
const BACKFILL_DONE_KEY = 'injection-trace-backfill-done';

function summaryKey(threadId: string, turnId: string): string {
  return `${SUMMARY_PREFIX}${threadId}:${turnId}`;
}
function detailKey(threadId: string, turnId: string): string {
  return `${DETAIL_PREFIX}${threadId}:${turnId}`;
}
function indexKey(threadId: string): string {
  return `${INDEX_PREFIX}${threadId}`;
}
function replaySnapshotHashKey(threadId: string, turnId: string): string {
  return `${REPLAY_SNAPSHOT_PREFIX}${threadId}:${turnId}`;
}
function terminalByInvocationKey(invocationId: string): string {
  return `${TERMINAL_BY_INVOCATION_PREFIX}${invocationId}`;
}
function unclassifiedEpisodeKey(ownerUserId: string): string {
  return `${UNCLASSIFIED_EPISODE_PREFIX}${ownerUserId}`;
}
function ownerEpisodeKey(ownerUserId: string): string {
  return `${OWNER_EPISODE_PREFIX}${ownerUserId}`;
}

function serializeTerminal(terminal: TraceTerminalExtension): string {
  return JSON.stringify({
    traceTurnId: terminal.traceTurnId,
    invocationId: terminal.invocationId,
    ownerUserId: terminal.ownerUserId,
    threadId: terminal.threadId,
    catId: terminal.catId,
    inputMessageId: terminal.inputMessageId,
    outputMessageId: terminal.outputMessageId,
    terminalAt: terminal.terminalAt,
    terminalKind: terminal.terminalKind,
    toolCalls: terminal.toolCalls.map((call) => ({
      toolName: call.toolName,
      ...(call.callId ? { callId: call.callId } : {}),
      outcome: call.outcome,
      ...(call.resultDetail ? { resultDetail: call.resultDetail } : {}),
    })),
  } satisfies TraceTerminalExtension);
}

const DEFAULT_DETAIL_TTL_SECONDS = 7 * 24 * 60 * 60;

/**
 * F257 R4: Atomic write of durable replay snapshots.
 *
 * KEYS[1] = summary key (CAS token; ioredis auto-prepends keyPrefix)
 * KEYS[2] = replay snapshot hash key
 * ARGV[1] = number of snapshots (N)
 * ARGV[2..N+1] = segmentId
 * ARGV[N+2..2N+1] = JSON snapshot
 *
 * Returns 1 on success, 0 if the turn has been deleted (no resurrection).
 */
const PERSIST_REPLAY_SNAPSHOTS_LUA = `
local summaryKey = KEYS[1]
local hashKey = KEYS[2]
local count = tonumber(ARGV[1])

if redis.call('EXISTS', summaryKey) == 0 then
  return 0
end

for i = 1, count do
  local segmentId = ARGV[1 + i]
  local json = ARGV[1 + count + i]
  redis.call('HSET', hashKey, segmentId, json)
end

return 1
`;

/**
 * F257 R4: Atomic delete of all trace data for a turn.
 *
 * KEYS[1] = summary key
 * KEYS[2] = detail key
 * KEYS[3] = turn index sorted-set key
 * KEYS[4] = replay snapshot hash key
 * ARGV[1] = turnId
 *
 * Removes the turn from the shared thread index via ZREM and deletes the
 * turn-private summary/detail/snapshot-hash keys. Sibling turns remain indexed.
 */
const DELETE_TURN_LUA = `
local summaryKey = KEYS[1]
local detailKey = KEYS[2]
local indexKey = KEYS[3]
local hashKey = KEYS[4]
local turnId = ARGV[1]

local removedFromIndex = redis.call('ZREM', indexKey, turnId)
local deletedKeys = redis.call('DEL', summaryKey, detailKey, hashKey)
return removedFromIndex + deletedKeys
`;

export class InjectionTraceStore {
  private readonly detailTtl: number;
  private backfillPromise: Promise<void> | null = null;
  private ownerEpisodeBackfillPromise: Promise<void> | null = null;

  constructor(
    private readonly redis: RedisClient,
    options?: { detailTtlSeconds?: number },
  ) {
    this.detailTtl = options?.detailTtlSeconds ?? DEFAULT_DETAIL_TTL_SECONDS;
  }

  async persist(summary: InjectionTraceSummary, detail: InjectionTraceDetail): Promise<void> {
    const sKey = summaryKey(summary.threadId, summary.turnId);
    const dKey = detailKey(detail.threadId, detail.turnId);
    const iKey = indexKey(summary.threadId);
    await this.redis.set(sKey, JSON.stringify(summary));
    await this.redis.set(dKey, JSON.stringify(detail), 'EX', this.detailTtl);
    await this.redis.zadd(iKey, summary.timestamp, summary.turnId);
    // F257 Phase D: register thread in discovery SET (SADD respects keyPrefix; SCAN does not).
    await this.redis.sadd(THREAD_REGISTRY_KEY, summary.threadId);
  }

  async getSummary(threadId: string, turnId: string): Promise<InjectionTraceSummary | null> {
    const raw = await this.redis.get(summaryKey(threadId, turnId));
    if (!raw) return null;
    try {
      return JSON.parse(raw) as InjectionTraceSummary;
    } catch {
      return null;
    }
  }

  async getDetail(threadId: string, turnId: string): Promise<InjectionTraceDetail | null> {
    const raw = await this.redis.get(detailKey(threadId, turnId));
    if (!raw) return null;
    try {
      return JSON.parse(raw) as InjectionTraceDetail;
    } catch {
      return null;
    }
  }

  /**
   * Close an invocation trace by exact ID.
   *
   * `SET NX` makes the first terminal payload canonical. A provider/queue retry
   * with the same payload is an idempotent duplicate; a different payload is a
   * provenance conflict and never overwrites the first closure. The summary may
   * arrive before or after this sidecar because tracing is fire-and-forget.
   */
  async closeEpisode(terminal: TraceTerminalExtension): Promise<{ outcome: 'created' | 'duplicate' }> {
    const serialized = serializeTerminal(terminal);
    const key = terminalByInvocationKey(terminal.invocationId);
    const created = await this.redis.set(key, serialized, 'NX');
    if (created === 'OK') {
      await this.redis.zadd(ownerEpisodeKey(terminal.ownerUserId), terminal.terminalAt, terminal.invocationId);
      await this.redis.zadd(unclassifiedEpisodeKey(terminal.ownerUserId), terminal.terminalAt, terminal.invocationId);
      await this.redis.sadd(UNCLASSIFIED_OWNER_REGISTRY_KEY, terminal.ownerUserId);
      return { outcome: 'created' };
    }

    const existing = await this.redis.get(key);
    if (existing === serialized) {
      // Repair a possible crash between canonical terminal SET and either index ZADD.
      await this.redis.zadd(ownerEpisodeKey(terminal.ownerUserId), terminal.terminalAt, terminal.invocationId);
      await this.redis.zadd(unclassifiedEpisodeKey(terminal.ownerUserId), terminal.terminalAt, terminal.invocationId);
      await this.redis.sadd(UNCLASSIFIED_OWNER_REGISTRY_KEY, terminal.ownerUserId);
      return { outcome: 'duplicate' };
    }
    throw new Error(`trace_episode_terminal_conflict:${terminal.invocationId}`);
  }

  async getTerminalByInvocationId(invocationId: string): Promise<TraceTerminalExtension | null> {
    const raw = await this.redis.get(terminalByInvocationKey(invocationId));
    if (!raw) return null;
    try {
      return JSON.parse(raw) as TraceTerminalExtension;
    } catch {
      return null;
    }
  }

  async getEpisodeByInvocationId(invocationId: string): Promise<TraceEpisode | null> {
    const terminal = await this.getTerminalByInvocationId(invocationId);
    if (!terminal) return null;
    const summary = await this.getSummary(terminal.threadId, terminal.traceTurnId);
    if (!summary) return null;
    return { summary, terminal };
  }

  /**
   * Frozen Unit evidence query over the durable, classification-independent
   * owner corpus. Both observed and absent segment opportunities are eligible.
   */
  async queryUnitWindow(
    ownerUserId: string,
    unitRefs: EvaluationUnitRef[],
    startMs: number,
    endMs: number,
  ): Promise<TraceEpisode[]> {
    await this.ensureOwnerEpisodeBackfilled();
    const segmentIds = new Set(unitRefs.filter((ref) => ref.unitType === 'segment').map((ref) => ref.unitId));
    if (segmentIds.size === 0 || endMs <= startMs) return [];
    const invocationIds = await this.redis.zrangebyscore(ownerEpisodeKey(ownerUserId), startMs, endMs - 1);
    const episodes: TraceEpisode[] = [];
    for (const invocationId of invocationIds) {
      const episode = await this.getEpisodeByInvocationId(invocationId);
      if (!episode || episode.terminal.ownerUserId !== ownerUserId) continue;
      if (!episode.summary.segments.some((segment) => segmentIds.has(segment.segmentId))) continue;
      episodes.push(episode);
    }
    return episodes.sort(
      (left, right) =>
        left.terminal.terminalAt - right.terminal.terminalAt ||
        left.terminal.invocationId.localeCompare(right.terminal.invocationId),
    );
  }

  /**
   * Count owner episodes in a time window without segment filtering.
   */
  async countOwnerWindow(ownerUserId: string, startMs: number, endMs: number): Promise<number> {
    await this.ensureOwnerEpisodeBackfilled();
    if (endMs <= startMs) return 0;
    return this.redis.zcount(ownerEpisodeKey(ownerUserId), startMs, endMs - 1);
  }

  /** Return immutable owner-pool members for one or more frozen cycle windows. */
  async ownerInvocationIds(ownerUserId: string, windows: Array<{ start: number; end: number }>): Promise<string[]> {
    await this.ensureOwnerEpisodeBackfilled();
    const seen = new Set<string>();
    const ordered: string[] = [];
    for (const window of windows) {
      if (window.end <= window.start) continue;
      const invocationIds = await this.redis.zrangebyscore(ownerEpisodeKey(ownerUserId), window.start, window.end - 1);
      for (const invocationId of invocationIds) {
        if (seen.has(invocationId)) continue;
        seen.add(invocationId);
        ordered.push(invocationId);
      }
    }
    return ordered;
  }

  /** Earliest durable invocation in the owner's single linear trace pool. */
  async earliestOwnerEpisode(ownerUserId: string): Promise<number | null> {
    await this.ensureOwnerEpisodeBackfilled();
    const first = (await this.redis.zrange(ownerEpisodeKey(ownerUserId), 0, 0, 'WITHSCORES')) as string[];
    if (first.length === 0) return null;
    const terminalAt = Number(first[1]);
    if (!Number.isFinite(terminalAt) || terminalAt < 0) {
      throw new Error(`invalid_owner_trace_score:${ownerUserId}`);
    }
    return terminalAt;
  }

  /**
   * Count owner episodes in a time window that observed a specific segment.
   *
   * Readiness counting is segment-level: different segments fire at different
   * frequencies, so their trace counts legitimately differ. An episode counts
   * toward a segment's readiness only if the episode's summary.segments
   * includes that segmentId with status=observed. Skipped/disabled segments
   * (status=absent) are not observations and do not count.
   */
  async countSegmentWindow(ownerUserId: string, segmentId: string, startMs: number, endMs: number): Promise<number> {
    await this.ensureOwnerEpisodeBackfilled();
    if (endMs <= startMs) return 0;
    const invocationIds = await this.redis.zrangebyscore(ownerEpisodeKey(ownerUserId), startMs, endMs - 1);
    let count = 0;
    for (const invocationId of invocationIds) {
      const episode = await this.getEpisodeByInvocationId(invocationId);
      if (!episode || episode.terminal.ownerUserId !== ownerUserId) continue;
      if (episode.summary.segments.some((seg) => seg.segmentId === segmentId && seg.status === 'observed')) {
        count++;
      }
    }
    return count;
  }

  async ensureOwnerEpisodeBackfilled(): Promise<void> {
    if (!this.ownerEpisodeBackfillPromise) {
      this.ownerEpisodeBackfillPromise = this.backfillOwnerEpisodeIndexes().catch((error) => {
        this.ownerEpisodeBackfillPromise = null;
        throw error;
      });
    }
    await this.ownerEpisodeBackfillPromise;
  }

  /** One-time additive migration for terminal sidecars written before the owner index existed. */
  private async backfillOwnerEpisodeIndexes(): Promise<void> {
    if (await this.redis.get(OWNER_EPISODE_BACKFILL_DONE_KEY)) return;
    // Lightweight test/in-memory stubs may intentionally omit SCAN. New
    // terminals are still indexed synchronously; simply skip legacy migration.
    if (typeof (this.redis as { scan?: unknown }).scan !== 'function') return;
    const prefix = this.redis.options?.keyPrefix ?? '';
    const pattern = `${prefix}${TERMINAL_BY_INVOCATION_PREFIX}*`;
    let cursor = '0';
    do {
      const [nextCursor, keys] = (await this.redis.scan(cursor, 'MATCH', pattern, 'COUNT', 200)) as [string, string[]];
      cursor = nextCursor;
      for (const physicalKey of keys) {
        const logicalKey = prefix && physicalKey.startsWith(prefix) ? physicalKey.slice(prefix.length) : physicalKey;
        await this.backfillOwnerEpisode(logicalKey);
      }
    } while (cursor !== '0');
    await this.redis.set(OWNER_EPISODE_BACKFILL_DONE_KEY, '1');
  }

  private async backfillOwnerEpisode(logicalKey: string): Promise<void> {
    const raw = await this.redis.get(logicalKey);
    if (!raw) return;
    try {
      const terminal = JSON.parse(raw) as TraceTerminalExtension;
      if (!terminal.ownerUserId || !terminal.invocationId || !Number.isFinite(terminal.terminalAt)) return;
      await this.redis.zadd(ownerEpisodeKey(terminal.ownerUserId), terminal.terminalAt, terminal.invocationId);
    } catch {
      // Preserve corrupt legacy sidecars for forensic inspection; skip indexing them.
    }
  }

  async listUnclassifiedInvocationIds(
    ownerUserId: string,
    startMs: number,
    endMs: number,
    limit = 100,
  ): Promise<string[]> {
    const ids = await this.redis.zrangebyscore(unclassifiedEpisodeKey(ownerUserId), startMs, endMs - 1);
    return ids.slice(0, limit);
  }

  async listUnclassifiedOwnerUserIds(): Promise<string[]> {
    return this.redis.smembers(UNCLASSIFIED_OWNER_REGISTRY_KEY);
  }

  /**
   * Count unclassified episodes for a given owner in a time window.
   * Lightweight O(log N) query for volume-based sweep trigger checks.
   */
  async countUnclassified(ownerUserId: string, startMs?: number, endMs?: number): Promise<number> {
    const key = unclassifiedEpisodeKey(ownerUserId);
    if (startMs != null || endMs != null) {
      return this.redis.zcount(key, startMs ?? '-inf', endMs != null ? endMs - 1 : '+inf');
    }
    return this.redis.zcard(key);
  }

  async markEpisodeClassified(ownerUserId: string, invocationId: string): Promise<void> {
    await this.redis.zrem(unclassifiedEpisodeKey(ownerUserId), invocationId);
  }

  async listTurnIds(
    threadId: string,
    options?: { limit?: number; offset?: number },
  ): Promise<{ turnIds: string[]; total: number }> {
    const iKey = indexKey(threadId);
    const total = await this.redis.zcard(iKey);
    const limit = options?.limit ?? 20;
    const offset = options?.offset ?? 0;
    const turnIds = await this.redis.zrevrange(iKey, offset, offset + limit - 1);
    return { turnIds, total };
  }

  async listSummaries(
    threadId: string,
    options?: { limit?: number; offset?: number },
  ): Promise<{ summaries: InjectionTraceSummary[]; total: number }> {
    const { turnIds, total } = await this.listTurnIds(threadId, options);
    const summaries: InjectionTraceSummary[] = [];
    for (const turnId of turnIds) {
      const summary = await this.getSummary(threadId, turnId);
      if (summary) summaries.push(summary);
    }
    return { summaries, total };
  }

  /**
   * F257: Time-windowed query for judgment engine consumption.
   *
   * Returns summaries within [startMs, endMs) for a given thread.
   * End-exclusive to match GuardRejectionEventLog.queryWindow boundary contract
   * and prevent double-counting in adjacent eval windows.
   *
   * The judgment engine uses this to compute per-segment injectionCount:
   *   queryWindow(threadId, windowStart, windowEnd) → filter segments by segmentId → count fired.
   */
  async queryWindow(threadId: string, startMs: number, endMs: number): Promise<InjectionTraceSummary[]> {
    const iKey = indexKey(threadId);
    // End-exclusive: ZRANGEBYSCORE is inclusive, so subtract 1ms to implement [start, end).
    // Matches GuardRejectionEventLog.queryWindow (line 177: `const upperBound = until - 1`).
    const turnIds = await this.redis.zrangebyscore(iKey, startMs, endMs - 1);
    const summaries: InjectionTraceSummary[] = [];
    for (const turnId of turnIds) {
      const summary = await this.getSummary(threadId, turnId);
      if (summary) summaries.push(summary);
    }
    return summaries;
  }

  /**
   * F257 Phase D: One-time backfill of the thread registry SET from pre-existing
   * index keys. Handles the cold-start gap: traces persisted before the registry
   * SET was added have index sorted sets but no SADD entry.
   *
   * Uses prefix-aware SCAN (ioredis keyPrefix does NOT apply to SCAN MATCH,
   * so we manually prepend the prefix). Controlled by a durable marker key
   * (BACKFILL_DONE_KEY) — NOT by registry emptiness, because new persist()
   * calls SADD new threads before backfill runs, making "registry non-empty"
   * an unreliable signal (terra review P1, 2026-07-14).
   *
   * Called lazily on first listTracedThreadIds() — runs once per process lifetime.
   * Marker is set only after success; failure allows retry.
   */
  private async backfillRegistry(): Promise<void> {
    const done = await this.redis.get(BACKFILL_DONE_KEY);
    if (done) return;

    const prefix = this.redis.options?.keyPrefix ?? '';
    const pattern = `${prefix}${INDEX_PREFIX}*`;
    const prefixLen = prefix.length + INDEX_PREFIX.length;
    const discovered = new Set<string>();

    let cursor = '0';
    do {
      // Type assertion: ioredis scan overloads cause circular inference in do-while
      const result = (await this.redis.scan(cursor, 'MATCH', pattern, 'COUNT', 200)) as [string, string[]];
      cursor = result[0];
      for (const key of result[1]) {
        const threadId = key.slice(prefixLen);
        if (threadId) discovered.add(threadId);
      }
    } while (cursor !== '0');

    if (discovered.size > 0) {
      await this.redis.sadd(THREAD_REGISTRY_KEY, ...discovered);
    }
    // Mark backfill as complete — only after successful SCAN.
    // No TTL: marker persists forever (backfill is a one-time migration).
    await this.redis.set(BACKFILL_DONE_KEY, '1');
  }

  /**
   * F257 Phase D: Discover all thread IDs that have injection trace data.
   * Used by the segment lifeline endpoint to scan across all threads.
   *
   * Primary: Redis SET (SMEMBERS) populated by persist() SADD calls.
   * Fallback: one-time backfill via prefix-aware SCAN for pre-existing data.
   * SADD/SMEMBERS respect ioredis keyPrefix; SCAN MATCH does not.
   */
  async listTracedThreadIds(): Promise<string[]> {
    if (!this.backfillPromise) {
      this.backfillPromise = this.backfillRegistry().catch(() => {
        this.backfillPromise = null; // Allow retry on transient failure
      });
    }
    await this.backfillPromise;
    return this.redis.smembers(THREAD_REGISTRY_KEY);
  }

  /**
   * F257 Console 判据④：atomically delete all trace data for a turn.
   *
   * Uses a single Lua script so summary/detail/index/snapshot-hash are removed
   * in one Redis execution — no window where a late snapshot writer can observe
   * a partially deleted turn and resurrect data.
   */
  async deleteTurn(threadId: string, turnId: string): Promise<void> {
    await this.redis.eval(
      DELETE_TURN_LUA,
      4,
      summaryKey(threadId, turnId),
      detailKey(threadId, turnId),
      indexKey(threadId),
      replaySnapshotHashKey(threadId, turnId),
      turnId,
    );
  }

  /**
   * F257 Console 判据④：persist durable, owner-scoped replay snapshots for a turn.
   *
   * TTL=0 by default — user-visible recoverable data. Stored as a single Redis
   * hash per turn so delete is one atomic key removal. The Lua script checks the
   * turn summary still exists before writing; if deleteTurn() won the race, the
   * write is suppressed and snapshots are not resurrected.
   */
  async persistReplaySnapshots(threadId: string, turnId: string, snapshots: ReplaySnapshot[]): Promise<void> {
    if (snapshots.length === 0) return;
    const args: string[] = [String(snapshots.length)];
    const jsons: string[] = [];
    for (const snapshot of snapshots) {
      args.push(snapshot.segmentId);
      jsons.push(JSON.stringify(snapshot));
    }
    args.push(...jsons);
    await this.redis.eval(
      PERSIST_REPLAY_SNAPSHOTS_LUA,
      2,
      summaryKey(threadId, turnId),
      replaySnapshotHashKey(threadId, turnId),
      ...args,
    );
  }

  async getReplaySnapshot(threadId: string, turnId: string, segmentId: string): Promise<ReplaySnapshot | null> {
    const raw = await this.redis.hget(replaySnapshotHashKey(threadId, turnId), segmentId);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as ReplaySnapshot;
    } catch {
      return null;
    }
  }
}
