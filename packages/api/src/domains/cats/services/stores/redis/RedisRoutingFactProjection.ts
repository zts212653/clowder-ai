/**
 * F257 V1 — RoutingDecisionFact query projection (§4.5.1 of the F257 redesign).
 *
 * Authority = the `routingFact` field embedded in the message hash (same-append
 * co-fate; RedisMessageStore). This module derives the owner-scoped query
 * projection and implements the §4.5.1 collection-integrity contract:
 *   ① persisted owner-scoped high-watermark (highest projected authority id)
 *   ② reconcile-before-evaluate: authority vs projection window对账 with
 *      synchronous idempotent rebuild; rebuild failure → metrics unmeasurable
 *   ③ projection worker errors are never silently swallowed — they are logged
 *      AND persisted to an error ZSET (collection-health visibility)
 *
 * Metric semantics (@解析成功率 per parserMode): T-A (§3.4) via the mapping
 * functions in routing-attempt.ts — not restated here.
 *
 * Redis-only by design: the in-memory MessageStore has no projection; metric
 * endpoints report unmeasurable without Redis.
 */

import type { RedisClient } from '@cat-cafe/shared/utils';
import { createModuleLogger } from '../../../../../infrastructure/logger.js';
import {
  isMetricEligibleOutcome,
  isSuccessOutcome,
  type RoutingParserMode,
} from '../../agents/routing/routing-attempt.js';
import type { StoredMessage } from '../ports/MessageStore.js';
import { MessageKeys } from '../redis-keys/message-keys.js';
import { RoutingFactKeys } from '../redis-keys/routing-fact-keys.js';
import {
  type PersistedMessageInvalidReason,
  parsePersistedMessageRecord,
  safeParseRoutingFact,
} from './redis-message-parsers.js';

const log = createModuleLogger('routing-fact-projection');

/**
 * v2.3.8: the projection commit and authority-state check are one Redis
 * linearization point. A stale append snapshot may only project while the
 * message is still active and its owner/fact still match that snapshot.
 */
const PROJECT_ACTIVE_ROUTING_FACT_LUA = `
local function drop_stale()
  redis.call('ZREM', KEYS[2], ARGV[1])
  redis.call('ZREM', KEYS[4], ARGV[1])
  return 0
end
if redis.call('EXISTS', KEYS[1]) == 0 then
  return drop_stale()
end
if redis.call('HGET', KEYS[1], '_tombstone') == '1' or redis.call('HGET', KEYS[1], 'deletedAt') then
  return drop_stale()
end
if redis.call('HGET', KEYS[1], 'id') ~= ARGV[1]
  or redis.call('HGET', KEYS[1], 'userId') ~= ARGV[2]
  or redis.call('HGET', KEYS[1], 'routingFact') ~= ARGV[3] then
  return drop_stale()
end
local effectiveOrderAt = redis.call('HGET', KEYS[1], 'deliveredAt')
  or redis.call('HGET', KEYS[1], 'timestamp')
if not effectiveOrderAt then
  return drop_stale()
end
redis.call('ZADD', KEYS[2], effectiveOrderAt, ARGV[1])
redis.call('ZREM', KEYS[4], ARGV[1])
local cur = redis.call('GET', KEYS[3])
if (not cur) or (ARGV[1] > cur) then
  redis.call('SET', KEYS[3], ARGV[1])
end
return 1
`;

/** Error visibility is also a projection write and must obey the same terminal fence. */
const RECORD_ACTIVE_PROJECTION_ERROR_LUA = `
local function drop_stale()
  redis.call('ZREM', KEYS[2], ARGV[1])
  return 0
end
if redis.call('EXISTS', KEYS[1]) == 0 then
  return drop_stale()
end
if redis.call('HGET', KEYS[1], '_tombstone') == '1' or redis.call('HGET', KEYS[1], 'deletedAt') then
  return drop_stale()
end
if redis.call('HGET', KEYS[1], 'id') ~= ARGV[1]
  or redis.call('HGET', KEYS[1], 'userId') ~= ARGV[3]
  or redis.call('HGET', KEYS[1], 'routingFact') ~= ARGV[4] then
  return drop_stale()
end
redis.call('ZADD', KEYS[2], ARGV[2], ARGV[1])
return 1
`;

export interface RoutingFactReconcileResult {
  ok: boolean;
  /**
   * set when !ok — distinguishes infrastructure failure from collection gap.
   * `malformed_provenance` also covers malformed canonical sender identity:
   * either fault makes the persisted message record untrustworthy.
   */
  reason?: 'redis_error' | 'malformed_provenance' | 'malformed_authority_fact' | 'malformed_record' | 'collection_gap';
  /** canonical validator rejected this many routingFact payloads */
  malformedFactCount?: number;
  /** messages carrying the canonical routingFact authority */
  cohortCount: number;
  /** valid canonical routingFact records (zero-token batches included) */
  authorityCount: number;
  projectedCount: number;
  repairedMissing: number;
  removedStale: number;
}

interface ModeAggregate {
  numerator: number;
  denominator: number;
  /** null when the denominator is 0 (no eligible attempts in window) */
  rate: number | null;
  batches: number;
}

export type ResolutionRateResult =
  | {
      unmeasurable: true;
      reason: 'reconcile_failed' | 'read_failed' | 'malformed_authority_fact';
      /** present for reconcile-derived unmeasurables — shows WHICH gap (sol R1 P1-1) */
      coverage?: RoutingFactReconcileResult;
      /** present for reason='malformed_authority_fact' (sol R1 P1-3) */
      malformedFacts?: number;
    }
  | {
      unmeasurable: false;
      window: { fromTs: number; toTs: number };
      coverage: RoutingFactReconcileResult;
      modes: Record<RoutingParserMode, ModeAggregate>;
      /** batches excluded by batch-level metricEligible=false (T-A 右截断) */
      excludedBatches: number;
      /** authority records whose fact field failed to parse — reported, never silently dropped */
      malformedFacts: number;
    };

type ProjectableMessage = Pick<StoredMessage, 'id' | 'userId' | 'timestamp' | 'routingFact'>;

/**
 * ioredis multi()/pipeline() exec() resolves per-command errors inside the
 * result tuples instead of rejecting. Every projection write path must check
 * them explicitly (sol R1 P1-5) — a null result array (aborted transaction)
 * counts as failure too.
 */
function assertExecResultsOk(results: Array<[error: Error | null, result: unknown]> | null, context: string): void {
  if (!results) {
    throw new Error(`${context}: pipeline exec aborted (null result)`);
  }
  for (const [err] of results) {
    if (err) throw err;
  }
}

export class RedisRoutingFactProjection {
  private readonly redis: RedisClient;

  constructor(redis: RedisClient) {
    this.redis = redis;
  }

  /**
   * Derive projection entries for one fact-carrying message (async worker path).
   * Never throws — failures are logged and persisted to the error ZSET (§4.5.1③);
   * reconcileWindow() repairs the gap before any evaluation reads the window.
   */
  async project(msg: ProjectableMessage): Promise<void> {
    const fact = msg.routingFact;
    // sol R1 P1-1: zero-token batches ARE authority records (producer-run marker)
    // — indexing them keeps the coverage cohort complete-by-construction.
    if (!fact) return;
    const serializedFact = JSON.stringify(fact);
    try {
      await this.redis.eval(
        PROJECT_ACTIVE_ROUTING_FACT_LUA,
        4,
        MessageKeys.detail(msg.id),
        RoutingFactKeys.index(msg.userId),
        RoutingFactKeys.watermark(msg.userId),
        RoutingFactKeys.projectionErrors(msg.userId),
        msg.id,
        msg.userId,
        serializedFact,
      );
    } catch (error) {
      log.error({ error, messageId: msg.id, ownerUserId: msg.userId }, 'routing-fact projection write failed');
      try {
        await this.redis.eval(
          RECORD_ACTIVE_PROJECTION_ERROR_LUA,
          2,
          MessageKeys.detail(msg.id),
          RoutingFactKeys.projectionErrors(msg.userId),
          msg.id,
          String(Date.now()),
          msg.userId,
          serializedFact,
        );
      } catch (markError) {
        log.error({ markError, messageId: msg.id }, 'routing-fact projection error marker write failed');
      }
    }
  }

  /**
   * Read the `routingFact` field for a list of message ids in one pipeline.
   * Returns null on ANY read error — partial reads would silently bias counts.
   */
  private async readFactPayloads(ids: readonly string[]): Promise<Array<string | null> | null> {
    if (ids.length === 0) return [];
    const pipeline = this.redis.pipeline();
    for (const id of ids) {
      pipeline.hget(MessageKeys.detail(id), 'routingFact');
    }
    const results = await pipeline.exec();
    if (!results || results.length !== ids.length) return null;
    const payloads: Array<string | null> = [];
    for (const entry of results) {
      const [err, value] = entry as [Error | null, unknown];
      if (err) return null;
      payloads.push(typeof value === 'string' && value.length > 0 ? value : null);
    }
    return payloads;
  }

  /**
   * Read canonical message records for a list of owner-timeline ids in one
   * pipeline. Returns null on ANY read error. A valid routingFact is both the
   * cohort marker and its authority; provenance carries observation lineage
   * only and never duplicates routing membership.
   */
  private async readCohortRecords(
    ownerUserId: string,
    candidates: readonly { id: string; score: string }[],
  ): Promise<Array<{
    state: 'missing' | 'legacy' | 'deleted' | 'invalid' | 'present';
    hasRoutingFact: boolean;
    invalidReason?: PersistedMessageInvalidReason;
    routingFact?: string;
  }> | null> {
    if (candidates.length === 0) return [];
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
    if (!results || results.length !== candidates.length) return null;
    const records: Array<{
      state: 'missing' | 'legacy' | 'deleted' | 'invalid' | 'present';
      hasRoutingFact: boolean;
      invalidReason?: PersistedMessageInvalidReason;
      routingFact?: string;
    }> = [];
    for (let index = 0; index < results.length; index += 1) {
      const entry = results[index];
      const candidate = candidates[index];
      const [err, value] = entry as [Error | null, unknown];
      if (err || !Array.isArray(value)) return null;
      const [
        storedId,
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
        fact,
        provenance,
      ] = value as Array<string | null>;
      const parsed = parsePersistedMessageRecord({
        expectedId: candidate.id,
        expectedOwnerUserId: ownerUserId,
        expectedTimelineScore: candidate.score,
        id: storedId,
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
        routingFact: fact,
        provenance,
      });
      records.push({
        state: parsed.state,
        hasRoutingFact: parsed.state === 'present' && typeof fact === 'string',
        ...(parsed.state === 'invalid' ? { invalidReason: parsed.reason } : {}),
        ...(parsed.state === 'present' && typeof fact === 'string' ? { routingFact: fact } : {}),
      });
    }
    return records;
  }

  /** Idempotent index repair: add missing members, drop stale ones. */
  private async repairIndex(
    ownerUserId: string,
    missing: readonly { id: string; score: string; routingFact: string }[],
    stale: readonly string[],
  ): Promise<{ repairedMissing: number; removedStale: number }> {
    if (missing.length === 0 && stale.length === 0) return { repairedMissing: 0, removedStale: 0 };
    const indexKey = RoutingFactKeys.index(ownerUserId);
    const repair = this.redis.multi();
    for (const entry of missing) {
      repair.eval(
        PROJECT_ACTIVE_ROUTING_FACT_LUA,
        4,
        MessageKeys.detail(entry.id),
        indexKey,
        RoutingFactKeys.watermark(ownerUserId),
        RoutingFactKeys.projectionErrors(ownerUserId),
        entry.id,
        ownerUserId,
        entry.routingFact,
      );
    }
    for (const id of stale) {
      repair.zrem(indexKey, id);
    }
    // sol R1 P1-5: a swallowed repair failure would report a repaired window
    // that is still broken; throwing routes to reconcileWindow's ok:false path.
    const results = await repair.exec();
    assertExecResultsOk(results, 'repairIndex');
    const checkedResults = results ?? [];
    return {
      repairedMissing: checkedResults.slice(0, missing.length).filter(([, result]) => Number(result) === 1).length,
      removedStale: checkedResults.slice(missing.length).filter(([, result]) => Number(result) > 0).length,
    };
  }

  /**
   * §4.5.1②: authority-vs-projection reconcile over [fromTs, toTs].
   * Authority enumeration = owner message timeline (written in the same append
   * pipeline as the fact) filtered to hashes carrying a routingFact field.
   * Idempotent: repairs missing members, removes stale ones. Any Redis error →
   * { ok: false } and the caller must treat the window as unmeasurable.
   */
  async reconcileWindow(ownerUserId: string, fromTs: number, toTs: number): Promise<RoutingFactReconcileResult> {
    const failed: RoutingFactReconcileResult = {
      ok: false,
      reason: 'redis_error',
      cohortCount: 0,
      authorityCount: 0,
      projectedCount: 0,
      repairedMissing: 0,
      removedStale: 0,
    };
    try {
      const entries = await this.redis.zrangebyscore(MessageKeys.user(ownerUserId), fromTs, toTs, 'WITHSCORES');
      const candidates: Array<{ id: string; score: string }> = [];
      for (let i = 0; i + 1 < entries.length; i += 2) {
        candidates.push({ id: entries[i] as string, score: entries[i + 1] as string });
      }

      const records = await this.readCohortRecords(ownerUserId, candidates);
      if (records === null) {
        log.error({ ownerUserId }, 'routing-fact reconcile: authority read error');
        return failed;
      }

      // F117 RFC realignment: routingFact is the authority for membership.
      // Authorship lives only in MessageFrom; provenance carries observation
      // lineage and must not duplicate either identity or routing state.
      const missingCount = records.filter((record) => record.state === 'missing').length;
      if (missingCount > 0) {
        log.error({ ownerUserId, missingCount }, 'routing-fact reconcile: indexed message hash missing');
        return { ...failed, reason: 'collection_gap' };
      }

      const declarationReasons: readonly PersistedMessageInvalidReason[] = [
        'malformed_provenance',
        'malformed_from',
        'from_identity_conflict',
      ];
      const malformedDeclarationCount = records.filter(
        (record) =>
          record.state === 'invalid' &&
          record.invalidReason !== undefined &&
          declarationReasons.includes(record.invalidReason),
      ).length;
      if (malformedDeclarationCount > 0) {
        log.error(
          { ownerUserId, malformedCount: malformedDeclarationCount },
          'routing-fact reconcile: malformed provenance in window',
        );
        return { ...failed, reason: 'malformed_provenance' };
      }

      const malformedFactCount = records.filter(
        (record) => record.state === 'invalid' && record.invalidReason === 'malformed_routing_fact',
      ).length;
      if (malformedFactCount > 0) {
        log.error({ ownerUserId, malformedFactCount }, 'routing-fact reconcile: malformed authority fact');
        return { ...failed, reason: 'malformed_authority_fact', malformedFactCount };
      }

      const malformedRecordCount = records.filter(
        (record) => record.state === 'invalid' && record.invalidReason !== 'malformed_routing_fact',
      ).length;
      if (malformedRecordCount > 0) {
        log.error({ ownerUserId, malformedRecordCount }, 'routing-fact reconcile: malformed authority record');
        return { ...failed, reason: 'malformed_record' };
      }

      const authority: Array<{ id: string; score: string; routingFact: string }> = [];
      let cohortCount = 0;
      for (let i = 0; i < candidates.length; i += 1) {
        const record = records[i];
        if (!record.hasRoutingFact) continue;
        cohortCount += 1;
        const candidate = candidates[i];
        if (candidate && record.routingFact) authority.push({ ...candidate, routingFact: record.routingFact });
      }

      const indexKey = RoutingFactKeys.index(ownerUserId);
      const projected = new Set(await this.redis.zrangebyscore(indexKey, fromTs, toTs));
      const authorityIds = new Set(authority.map((entry) => entry.id));
      const missing = authority.filter((entry) => !projected.has(entry.id));
      const stale = [...projected].filter((id) => !authorityIds.has(id));

      const repair = await this.repairIndex(ownerUserId, missing, stale);
      if (repair.repairedMissing > 0 || repair.removedStale > 0) {
        log.info({ ownerUserId, ...repair }, 'routing-fact projection reconciled');
      }

      const base = {
        cohortCount,
        authorityCount: authority.length,
        projectedCount: projected.size,
        repairedMissing: repair.repairedMissing,
        removedStale: repair.removedStale,
      };
      return { ok: true, ...base };
    } catch (error) {
      log.error({ error, ownerUserId }, 'routing-fact reconcile failed');
      return failed;
    }
  }

  /** T-A metric columns applied to one batch (mutates the matching mode aggregate). */
  private static applyBatch(
    modes: Record<RoutingParserMode, ModeAggregate>,
    batch: ReturnType<typeof safeParseRoutingFact>,
    counters: { excludedBatches: number; malformedFacts: number },
  ): void {
    const mode = batch ? modes[batch.parserMode] : undefined;
    if (!batch || !mode) {
      counters.malformedFacts += 1;
      return;
    }
    if (!batch.metricEligible) {
      counters.excludedBatches += 1;
      return;
    }
    mode.batches += 1;
    for (const attempt of batch.attempts) {
      if (!isMetricEligibleOutcome(attempt.outcome)) continue;
      mode.denominator += 1;
      if (isSuccessOutcome(attempt.outcome)) mode.numerator += 1;
    }
  }

  /**
   * V1 active metric: @解析成功率 per parserMode over a reconciled window.
   * Numerator/denominator/eligibility come from T-A via routing-attempt.ts
   * mapping functions. Reconcile failure → unmeasurable (§4.5.1②).
   */
  async computeResolutionRate(ownerUserId: string, fromTs: number, toTs: number): Promise<ResolutionRateResult> {
    const coverage = await this.reconcileWindow(ownerUserId, fromTs, toTs);
    if (!coverage.ok) {
      if (coverage.reason === 'malformed_authority_fact') {
        return {
          unmeasurable: true,
          reason: 'malformed_authority_fact',
          coverage,
          malformedFacts: coverage.malformedFactCount ?? 1,
        };
      }
      return {
        unmeasurable: true,
        reason: 'reconcile_failed',
        coverage,
      };
    }

    try {
      const ids = await this.redis.zrangebyscore(RoutingFactKeys.index(ownerUserId), fromTs, toTs);
      const payloads = await this.readFactPayloads(ids);
      if (payloads === null) return { unmeasurable: true, reason: 'read_failed' };

      const modes: Record<RoutingParserMode, ModeAggregate> = {
        a2a: { numerator: 0, denominator: 0, rate: null, batches: 0 },
        user: { numerator: 0, denominator: 0, rate: null, batches: 0 },
      };
      const counters = { excludedBatches: 0, malformedFacts: 0 };
      for (const payload of payloads) {
        RedisRoutingFactProjection.applyBatch(modes, safeParseRoutingFact(payload ?? undefined), counters);
      }
      // sol R1 P1-3: an authority fact that fails full validation means the
      // window's exact denominators cannot be trusted — no partial rate.
      if (counters.malformedFacts > 0) {
        return {
          unmeasurable: true,
          reason: 'malformed_authority_fact',
          coverage,
          malformedFacts: counters.malformedFacts,
        };
      }
      for (const mode of Object.values(modes)) {
        mode.rate = mode.denominator > 0 ? mode.numerator / mode.denominator : null;
      }

      return {
        unmeasurable: false,
        window: { fromTs, toTs },
        coverage,
        modes,
        excludedBatches: counters.excludedBatches,
        malformedFacts: counters.malformedFacts,
      };
    } catch (error) {
      log.error({ error, ownerUserId }, 'routing-fact metric read failed');
      return { unmeasurable: true, reason: 'read_failed' };
    }
  }

  /** Collection-health snapshot for the Console badge (§4.5.1① + ③ visibility). */
  async getHealth(ownerUserId: string): Promise<{ ok: boolean; watermark: string | null; errorCount: number }> {
    try {
      const [watermark, errorCount] = await Promise.all([
        this.redis.get(RoutingFactKeys.watermark(ownerUserId)),
        this.redis.zcard(RoutingFactKeys.projectionErrors(ownerUserId)),
      ]);
      return { ok: true, watermark: watermark ?? null, errorCount };
    } catch (error) {
      log.error({ error, ownerUserId }, 'routing-fact health read failed');
      return { ok: false, watermark: null, errorCount: 0 };
    }
  }
}
