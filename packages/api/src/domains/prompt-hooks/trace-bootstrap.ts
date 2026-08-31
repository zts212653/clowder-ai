/**
 * TraceBootstrap — F237 (Trace v0)
 *
 * Module-level singleton for InjectionTraceStore.
 * Bootstrapped once at server startup when Redis is available.
 */

import { randomUUID } from 'node:crypto';
import { EVALUATION_READINESS_WINDOW_MS, EVALUATION_TRACE_VOLUME_THRESHOLD } from '@cat-cafe/shared';
import type { RedisClient } from '@cat-cafe/shared/utils';
import type { EvaluationCatalog } from '../../infrastructure/harness-eval/evaluation/evaluation-catalog.js';
import { ObjectiveEvaluationRuntime } from '../../infrastructure/harness-eval/evaluation/ObjectiveEvaluationRuntime.js';
import { UnitSemanticEvaluationCoordinator } from '../../infrastructure/harness-eval/evaluation/UnitSemanticEvaluationCoordinator.js';
import { UnitSemanticEvaluationJobStore } from '../../infrastructure/harness-eval/evaluation/UnitSemanticEvaluationJobStore.js';
import { PendingTraceMarkerStore } from '../../infrastructure/harness-eval/trace-annotation/PendingTraceMarkerStore.js';
import { resolvePendingTraceMarkers } from '../../infrastructure/harness-eval/trace-annotation/resolve-pending-markers.js';
import { SemanticSweepCoordinator } from '../../infrastructure/harness-eval/trace-annotation/SemanticSweepCoordinator.js';
import { SemanticSweepJobStore } from '../../infrastructure/harness-eval/trace-annotation/SemanticSweepJobStore.js';
import { deriveStructuredTraceAnnotations } from '../../infrastructure/harness-eval/trace-annotation/structured-rule-tagger.js';
import { TraceAnnotationStore } from '../../infrastructure/harness-eval/trace-annotation/TraceAnnotationStore.js';
import type { IMessageStore, StoredToolEvent } from '../cats/services/stores/ports/MessageStore.js';
import { InjectionTraceStore } from './InjectionTraceStore.js';
import { closeTraceEpisode } from './trace-episode-terminal.js';

let _redis: RedisClient | null = null;
let _traceStore: InjectionTraceStore | null = null;
let _markerStore: PendingTraceMarkerStore | null = null;
let _annotationStore: TraceAnnotationStore | null = null;
let _evaluationRuntime: ObjectiveEvaluationRuntime | null = null;
let _semanticSweepCoordinator: SemanticSweepCoordinator | null = null;
let _unitSemanticEvaluationCoordinator: UnitSemanticEvaluationCoordinator | null = null;

/** Bootstrap the trace store singleton. Call once at server startup. */
export function bootstrapTraceStore(redis: RedisClient): void {
  _redis = redis;
  _traceStore = new InjectionTraceStore(redis);
  _markerStore = new PendingTraceMarkerStore(redis);
  _annotationStore = new TraceAnnotationStore(redis);
}

export function bootstrapObjectiveEvaluationRuntime(redis: RedisClient, catalog: EvaluationCatalog): void {
  if (!_annotationStore || !_traceStore) throw new Error('trace_store_must_be_bootstrapped_first');
  _evaluationRuntime = new ObjectiveEvaluationRuntime(redis, catalog, _annotationStore, { traceStore: _traceStore });
}

export function bootstrapSemanticSweepCoordinator(redis: RedisClient, messageStore: IMessageStore): void {
  if (!_traceStore || !_evaluationRuntime) throw new Error('objective_evaluation_runtime_must_be_bootstrapped_first');
  const hydrateContext = (episode: import('@cat-cafe/shared').TraceEpisode) =>
    hydrateTraceContext(messageStore, episode);
  _semanticSweepCoordinator = new SemanticSweepCoordinator({
    traceStore: _traceStore,
    jobStore: new SemanticSweepJobStore(redis),
    annotationSink: _evaluationRuntime,
    catalog: _evaluationRuntime.catalog,
    hydrateContext,
  });
  _unitSemanticEvaluationCoordinator = new UnitSemanticEvaluationCoordinator({
    runtime: _evaluationRuntime,
    jobStore: new UnitSemanticEvaluationJobStore(redis),
    hydrateContext,
  });
}

async function hydrateTraceContext(
  messageStore: IMessageStore,
  episode: import('@cat-cafe/shared').TraceEpisode,
): Promise<
  import('../../infrastructure/harness-eval/trace-annotation/SemanticSweepService.js').SemanticEpisodeContext
> {
  const ids = [episode.terminal.inputMessageId, episode.terminal.outputMessageId].filter(
    (value): value is string => typeof value === 'string' && value.length > 0,
  );
  const messages = ids.length > 0 ? await messageStore.getByIds(ids) : [];
  const owned = messages.filter(
    (message) => message.userId === episode.terminal.ownerUserId && message.threadId === episode.terminal.threadId,
  );
  const byId = new Map(owned.map((message) => [message.id, message]));
  const truncate = (value: string | undefined): string | null =>
    value === undefined ? null : value.length <= 2_000 ? value : `${value.slice(0, 2_000)}\n…[truncated]`;
  const inputMessage = episode.terminal.inputMessageId ? byId.get(episode.terminal.inputMessageId) : undefined;
  const surrounding = inputMessage
    ? await messageStore.getByThreadBefore(
        episode.terminal.threadId,
        inputMessage.timestamp + 1,
        8,
        undefined,
        episode.terminal.ownerUserId,
      )
    : [];
  return {
    episode,
    inputText: truncate(
      episode.terminal.inputMessageId ? byId.get(episode.terminal.inputMessageId)?.content : undefined,
    ),
    outputText: truncate(
      episode.terminal.outputMessageId ? byId.get(episode.terminal.outputMessageId)?.content : undefined,
    ),
    contextMessages: surrounding
      .filter(
        (message) =>
          message.userId === episode.terminal.ownerUserId &&
          message.threadId === episode.terminal.threadId &&
          !message.deletedAt,
      )
      .map((message) => ({
        messageId: message.id,
        catId: message.catId,
        content: message.content.length <= 1_200 ? message.content : `${message.content.slice(0, 1_200)}\n…[truncated]`,
      })),
  };
}

/** Get the bootstrapped trace store (null if Redis unavailable). */
export function getTraceStore(): InjectionTraceStore | null {
  return _traceStore;
}

export function getTraceEvaluationStores(): {
  traceStore: InjectionTraceStore;
  markerStore: PendingTraceMarkerStore;
  annotationStore: TraceAnnotationStore;
  annotationSink?: ObjectiveEvaluationRuntime;
} | null {
  if (!_traceStore || !_markerStore || !_annotationStore) return null;
  return {
    traceStore: _traceStore,
    markerStore: _markerStore,
    annotationStore: _annotationStore,
    ...(_evaluationRuntime ? { annotationSink: _evaluationRuntime } : {}),
  };
}

export function getObjectiveEvaluationRuntime(): ObjectiveEvaluationRuntime | null {
  return _evaluationRuntime;
}

export function getSemanticSweepCoordinator(): SemanticSweepCoordinator | null {
  return _semanticSweepCoordinator;
}

export function getUnitSemanticEvaluationCoordinator(): UnitSemanticEvaluationCoordinator | null {
  return _unitSemanticEvaluationCoordinator;
}

export async function resolvePendingMarkersForInvocation(invocationId: string): Promise<boolean> {
  const stores = getTraceEvaluationStores();
  if (!stores) return false;
  const result = await resolvePendingTraceMarkers({ invocationId, ...stores });
  return result.unitEvaluationReady;
}

// ---------------------------------------------------------------------------
// F257: Volume-based SemanticSweep auto-trigger
// ---------------------------------------------------------------------------
// One persistent owner-scoped generation record is the source of truth. Redis
// Lua transitions compare generation + attemptId, so a delayed invoke result
// cannot overwrite a newer completion/retry generation. A sorted-set due index
// provides restart-safe retries; the state record has no TTL and is removed only
// after an observed terminal condition (zero remaining or the safety cap).
// ---------------------------------------------------------------------------

/** @internal Exported for testing. */
export const SWEEP_VOLUME_THRESHOLD = EVALUATION_TRACE_VOLUME_THRESHOLD;
/** @internal Exported for testing — persistent owner-scoped state key. */
export const SWEEP_STATE_KEY_PREFIX = 'harness-semantic-sweep-state:';
/** @internal Exported for testing — owners whose lease/retry is due. */
export const SWEEP_RETRY_DUE_KEY = 'harness-semantic-sweep-retry-due';
/** @internal Exported for testing. */
export const SWEEP_LEASE_SECONDS = 10 * 60;
/** @internal Exported for testing. */
export const SWEEP_FAILURE_RETRY_SECONDS = 30;
/** @internal Exported for testing. */
export const SWEEP_MAX_DRAIN_ROUNDS = 25; // Safety cap (~250 episodes)
/** Coordinator default prepare() limit — each dispatch processes this many. */
export const SWEEP_BATCH_SIZE = 10;
/** 7-day window matching handleTriggerNow / SemanticSweepCoordinator.prepare */
const SWEEP_WINDOW_MS = EVALUATION_READINESS_WINDOW_MS;

/**
 * Late-bound callback for invoking the eval cat when volume conditions are met.
 * Returns { dispatched, jobId } — jobId is the SemanticSweepCoordinator job
 * that was prepared, used to fence the completion-driven drain release.
 * Wired during server startup (index.ts) with handleTriggerNow deps.
 */
export type VolumeSweepInvokeResult =
  | { dispatched: false }
  | { dispatched: true; jobId?: string; unitEvaluationJobIds?: string[] };
export type VolumeSweepInvokeCallback = (ownerUserId: string) => Promise<VolumeSweepInvokeResult>;
let _volumeSweepInvoke: VolumeSweepInvokeCallback | null = null;

/** Bind the eval cat invocation callback. Called once during server startup. */
export function bindVolumeSweepInvoke(cb: VolumeSweepInvokeCallback): void {
  _volumeSweepInvoke = cb;
}

type VolumeSweepStateBase = {
  version: 1;
  generation: number;
  attemptId: string;
  completedRounds: number;
  startedAt: number;
  leaseUntil: number;
};

export type VolumeSweepState = VolumeSweepStateBase &
  (
    | { phase: 'in_flight'; jobId: string }
    | { phase: 'dispatching' | 'retry_wait'; jobId?: string }
    | { phase: 'ready'; jobId?: never }
  );

const BEGIN_ATTEMPT_LUA = `
  -- volume-sweep:begin-attempt
  local raw = redis.call('GET', KEYS[1])
  local previous = nil
  if raw then
    previous = cjson.decode(raw)
    if type(previous.leaseUntil) ~= 'number' or previous.leaseUntil > tonumber(ARGV[2]) then
      return {0, raw}
    end
    if tonumber(previous.completedRounds or 0) >= tonumber(ARGV[5]) then
      return {-1, raw}
    end
  end
  local next = {
    version = 1,
    generation = previous and (tonumber(previous.generation or 0) + 1) or 1,
    attemptId = ARGV[4],
    phase = 'dispatching',
    completedRounds = previous and tonumber(previous.completedRounds or 0) or 0,
    startedAt = previous and tonumber(previous.startedAt or ARGV[2]) or tonumber(ARGV[2]),
    leaseUntil = tonumber(ARGV[3])
  }
  if previous and type(previous.jobId) == 'string' then next.jobId = previous.jobId end
  local encoded = cjson.encode(next)
  redis.call('SET', KEYS[1], encoded)
  redis.call('ZADD', KEYS[2], ARGV[3], ARGV[1])
  return {1, encoded}
`;

const ATTACH_JOB_LUA = `
  -- volume-sweep:attach-job
  local raw = redis.call('GET', KEYS[1])
  if not raw then return 0 end
  local state = cjson.decode(raw)
  if tonumber(state.generation) ~= tonumber(ARGV[2]) or state.attemptId ~= ARGV[3] then return 0 end
  state.phase = 'in_flight'
  state.jobId = ARGV[4]
  state.leaseUntil = tonumber(ARGV[5])
  redis.call('SET', KEYS[1], cjson.encode(state))
  redis.call('ZADD', KEYS[2], ARGV[5], ARGV[1])
  return 1
`;

const FAIL_ATTEMPT_LUA = `
  -- volume-sweep:fail-attempt
  local raw = redis.call('GET', KEYS[1])
  if not raw then return 0 end
  local state = cjson.decode(raw)
  if tonumber(state.generation) ~= tonumber(ARGV[2]) or state.attemptId ~= ARGV[3] then return 0 end
  state.phase = 'retry_wait'
  state.leaseUntil = tonumber(ARGV[4])
  redis.call('SET', KEYS[1], cjson.encode(state))
  redis.call('ZADD', KEYS[2], ARGV[4], ARGV[1])
  return 1
`;

const COMPLETE_JOB_LUA = `
  -- volume-sweep:complete-job
  local raw = redis.call('GET', KEYS[1])
  if not raw then return 0 end
  local state = cjson.decode(raw)
  if type(state.jobId) ~= 'string' or state.jobId ~= ARGV[2] then return 0 end
  state.generation = tonumber(state.generation or 0) + 1
  state.attemptId = ARGV[3]
  state.phase = 'ready'
  state.completedRounds = tonumber(state.completedRounds or 0) + 1
  state.leaseUntil = tonumber(ARGV[4])
  state.jobId = nil
  redis.call('SET', KEYS[1], cjson.encode(state))
  redis.call('ZADD', KEYS[2], ARGV[4], ARGV[1])
  return 1
`;

const CLEAR_STATE_LUA = `
  -- volume-sweep:clear-state
  local raw = redis.call('GET', KEYS[1])
  if not raw then
    redis.call('ZREM', KEYS[2], ARGV[1])
    return 1
  end
  local state = cjson.decode(raw)
  if tonumber(state.generation) ~= tonumber(ARGV[2]) or state.attemptId ~= ARGV[3] then return 0 end
  redis.call('DEL', KEYS[1])
  redis.call('ZREM', KEYS[2], ARGV[1])
  return 1
`;

const CLEAR_ORPHAN_DUE_LUA = `
  -- volume-sweep:clear-orphan-due
  if redis.call('EXISTS', KEYS[1]) == 1 then return 0 end
  redis.call('ZREM', KEYS[2], ARGV[1])
  return 1
`;

function stateKey(ownerUserId: string): string {
  return `${SWEEP_STATE_KEY_PREFIX}${ownerUserId}`;
}

function decodeVolumeSweepState(raw: string | null): VolumeSweepState | null {
  if (!raw) return null;
  const state = JSON.parse(raw) as VolumeSweepState;
  if (
    state.version !== 1 ||
    !Number.isInteger(state.generation) ||
    typeof state.attemptId !== 'string' ||
    !Number.isInteger(state.completedRounds) ||
    typeof state.startedAt !== 'number' ||
    typeof state.leaseUntil !== 'number' ||
    !['dispatching', 'in_flight', 'retry_wait', 'ready'].includes(state.phase) ||
    (state.phase === 'in_flight' && (typeof state.jobId !== 'string' || state.jobId.length === 0)) ||
    (state.phase === 'ready' && state.jobId !== undefined)
  ) {
    throw new Error('invalid_volume_sweep_state');
  }
  return state;
}

async function beginVolumeSweepAttempt(
  redis: RedisClient,
  ownerUserId: string,
  now: number,
): Promise<VolumeSweepState | null> {
  const attemptId = randomUUID();
  const leaseUntil = now + SWEEP_LEASE_SECONDS * 1000;
  const result = (await redis.eval(
    BEGIN_ATTEMPT_LUA,
    2,
    stateKey(ownerUserId),
    SWEEP_RETRY_DUE_KEY,
    ownerUserId,
    now,
    leaseUntil,
    attemptId,
    SWEEP_MAX_DRAIN_ROUNDS,
  )) as [number | string, string];
  return Number(result[0]) === 1 ? decodeVolumeSweepState(result[1]) : null;
}

async function clearVolumeSweepState(redis: RedisClient, ownerUserId: string, state: VolumeSweepState): Promise<void> {
  await redis.eval(
    CLEAR_STATE_LUA,
    2,
    stateKey(ownerUserId),
    SWEEP_RETRY_DUE_KEY,
    ownerUserId,
    state.generation,
    state.attemptId,
  );
}

async function scheduleVolumeSweepRetry(
  redis: RedisClient,
  ownerUserId: string,
  attempt: VolumeSweepState,
  retryAt: number,
): Promise<void> {
  await redis.eval(
    FAIL_ATTEMPT_LUA,
    2,
    stateKey(ownerUserId),
    SWEEP_RETRY_DUE_KEY,
    ownerUserId,
    attempt.generation,
    attempt.attemptId,
    retryAt,
  );
}

/**
 * Check whether volume-based sweep conditions are met and trigger if so.
 * Called fire-and-forget after each trace persistence, and internally by
 * advanceVolumeSweepDrain after batch completion (the wake mechanism).
 */
export async function checkAndTriggerVolumeSweep(
  ownerUserId: string,
  now = Date.now(),
  unitEvaluationReady = false,
): Promise<void> {
  if (!_traceStore || !_volumeSweepInvoke || !_redis) return;
  const redis = _redis;

  try {
    const count = await _traceStore.countUnclassified(ownerUserId, now - SWEEP_WINDOW_MS, now + 1);
    const existing = decodeVolumeSweepState(await redis.get(stateKey(ownerUserId)));
    if (!existing && count < SWEEP_VOLUME_THRESHOLD) {
      if (unitEvaluationReady) await invokePendingUnitEvaluation(ownerUserId);
      return;
    }
    if (existing && (count === 0 || existing.completedRounds >= SWEEP_MAX_DRAIN_ROUNDS)) {
      await clearVolumeSweepState(redis, ownerUserId, existing);
      if (unitEvaluationReady) await invokePendingUnitEvaluation(ownerUserId);
      return;
    }
    const attempt = await beginVolumeSweepAttempt(redis, ownerUserId, now);
    if (!attempt) return;
    let result: VolumeSweepInvokeResult;
    try {
      result = await _volumeSweepInvoke(ownerUserId);
    } catch {
      await scheduleVolumeSweepRetry(redis, ownerUserId, attempt, now + SWEEP_FAILURE_RETRY_SECONDS * 1000);
      return;
    }
    if (!result.dispatched || typeof result.jobId !== 'string' || result.jobId.length === 0) {
      await scheduleVolumeSweepRetry(redis, ownerUserId, attempt, now + SWEEP_FAILURE_RETRY_SECONDS * 1000);
      return;
    }
    const leaseUntil = now + SWEEP_LEASE_SECONDS * 1000;
    await redis.eval(
      ATTACH_JOB_LUA,
      2,
      stateKey(ownerUserId),
      SWEEP_RETRY_DUE_KEY,
      ownerUserId,
      attempt.generation,
      attempt.attemptId,
      result.jobId,
      leaseUntil,
    );
  } catch {
    // Persistent state remains indexed for the recovery worker.
  }
}

async function invokePendingUnitEvaluation(ownerUserId: string): Promise<void> {
  if (!_volumeSweepInvoke) return;
  try {
    const result = await _volumeSweepInvoke(ownerUserId);
    // A pending snapshot remains the durable retry anchor when dispatch fails;
    // subsequent traces and the cadence sweep will retry without duplicating it.
    if (!result.dispatched || !result.unitEvaluationJobIds?.length) return;
  } catch {
    // Best-effort fast path. The immutable pending Unit is not consumed.
  }
}

/**
 * Advance volume sweep drain after a semantic sweep batch completes.
 * Called from submit-semantic-sweep.ts after coordinator.submit().
 *
 * The Lua transition accepts only the active jobId, advances generation, and
 * makes the owner immediately due. Duplicate/stale completions are no-ops.
 * The direct checker call is the fast path; the due index is the crash-safe
 * fallback if this process stops between transition and dispatch.
 */
export async function advanceVolumeSweepDrain(
  ownerUserId: string,
  completedJobId: string,
  unitEvaluationReady = false,
): Promise<void> {
  if (!_redis) return;
  try {
    const now = Date.now();
    const result = await _redis.eval(
      COMPLETE_JOB_LUA,
      2,
      stateKey(ownerUserId),
      SWEEP_RETRY_DUE_KEY,
      ownerUserId,
      completedJobId,
      randomUUID(),
      now,
    );
    if (result !== 1) {
      if (unitEvaluationReady) await checkAndTriggerVolumeSweep(ownerUserId, now, true);
      return;
    }
    await checkAndTriggerVolumeSweep(ownerUserId, now, unitEvaluationReady);
  } catch {
    // Persistent state remains indexed for the recovery worker.
  }
}

/** Process owner states whose dispatch/completion lease is due. */
export async function drainDueVolumeSweepRetries(now = Date.now(), limit = 25): Promise<number> {
  if (!_redis || !_traceStore || !_volumeSweepInvoke) return 0;
  const owners = await _redis.zrangebyscore(SWEEP_RETRY_DUE_KEY, '-inf', now, 'LIMIT', 0, limit);
  for (const ownerUserId of owners) {
    await checkAndTriggerVolumeSweep(ownerUserId, now);
    await _redis.eval(CLEAR_ORPHAN_DUE_LUA, 2, stateKey(ownerUserId), SWEEP_RETRY_DUE_KEY, ownerUserId);
  }
  return owners.length;
}

export async function annotateStructuredRulesForInvocation(invocationId: string): Promise<boolean> {
  const stores = getTraceEvaluationStores();
  if (!stores) return false;
  const episode = await stores.traceStore.getEpisodeByInvocationId(invocationId);
  if (!episode) return false;
  const annotations = deriveStructuredTraceAnnotations(episode);
  let unitEvaluationReady = false;
  for (const annotation of annotations) {
    const result = await (stores.annotationSink ?? stores.annotationStore).append(annotation);
    unitEvaluationReady ||= 'unitEvaluationReady' in result && result.unitEvaluationReady === true;
  }
  if (annotations.length > 0) {
    await stores.traceStore.markEpisodeClassified(episode.terminal.ownerUserId, invocationId);
  }
  return unitEvaluationReady;
}

/**
 * Close one trace only after its summary and terminal output are durable, then run
 * deterministic annotation before considering the owner-level semantic sweep.
 */
export async function finalizeTraceEpisode(params: {
  traceTurnId: string;
  invocationId: string;
  ownerUserId: string;
  threadId: string;
  catId: string;
  inputMessageId: string | null;
  outputMessageId: string | null;
  terminalKind: 'completed' | 'failed' | 'cancelled';
  toolEvents: readonly StoredToolEvent[];
  terminalAt?: number;
}): Promise<void> {
  if (!_traceStore) return;
  await closeTraceEpisode({ traceStore: _traceStore, ...params });
  const markerUnitReady = await resolvePendingMarkersForInvocation(params.invocationId);
  const structuredUnitReady = await annotateStructuredRulesForInvocation(params.invocationId);
  const scheduledUnits =
    (await _evaluationRuntime?.scheduleTraceVolume(params.ownerUserId, (params.terminalAt ?? Date.now()) + 1)) ?? 0;
  await checkAndTriggerVolumeSweep(
    params.ownerUserId,
    params.terminalAt ?? Date.now(),
    markerUnitReady || structuredUnitReady || scheduledUnits > 0,
  );
}
