import type { SessionCacheObservation, SessionCacheWarmth, SessionRecord } from '@cat-cafe/shared';
import type { TokenUsage } from '../../types.js';
import { type CacheRetentionWarmProof, validRetentionProof } from './cache-retention-proof.js';

const FIVE_MINUTES = 5 * 60_000;
const ONE_HOUR = 60 * 60_000;
const MIN_EMPIRICAL_SAMPLES = 3;
const MAX_SAMPLES = 16;
const positive = (value: number | undefined): value is number =>
  value !== undefined && Number.isSafeInteger(value) && value > 0;

export function observedCacheRetentionMs(usage: TokenUsage): number | undefined {
  // A mixed write cannot promise the longest tier for the entire prefix.
  if (positive(usage.cacheCreation5mTokens)) return FIVE_MINUTES;
  if (positive(usage.cacheCreation1hTokens)) return ONE_HOUR;
  return undefined;
}

export function observeSessionCache(input: {
  record: SessionRecord;
  invocationId: string;
  runtime: string;
  model: string;
  executionBoundaryRef?: string;
  requestStartedAt: number;
  observedAt: number;
  contextTokens: number;
  usage: TokenUsage;
}): SessionCacheObservation | undefined {
  const { record, usage } = input;
  const previous = record.lastUsage?.cacheObservation;
  if (
    !positive(input.contextTokens) ||
    !positive(input.requestStartedAt) ||
    input.requestStartedAt > input.observedAt ||
    !record.cliSessionId ||
    !input.model
  )
    return previous;
  const sameLineage =
    previous?.nativeSessionId === record.cliSessionId &&
    previous.runtime === input.runtime &&
    previous.model === input.model &&
    previous.compressionCount === record.compressionCount;
  const samples = sameLineage ? [...previous.confirmedWarmGapsMs] : [];
  const singleRequest = usage.inputTokens === input.contextTokens && usage.numTurns === 1;
  const matchedPrefix =
    sameLineage &&
    singleRequest &&
    (usage.cacheReadTokens ?? 0) >= previous.contextTokens * 0.95 &&
    input.contextTokens >= previous.contextTokens * 0.95;
  if (matchedPrefix && previous.invocationId !== input.invocationId) {
    // Previous response time is later than its request start: this interval is a conservative proof.
    const gap = input.requestStartedAt - previous.observedAt;
    if (gap >= FIVE_MINUTES) samples.push(gap);
  }
  const boundedSamples = samples.slice(-MAX_SAMPLES);
  const tier = observedCacheRetentionMs(usage);
  const retainedTier =
    sameLineage && previous.retentionSource === 'usage_ttl' && matchedPrefix ? previous.retentionMs : undefined;
  const empirical =
    boundedSamples.length >= MIN_EMPIRICAL_SAMPLES
      ? [...boundedSamples].sort((a, b) => b - a)[MIN_EMPIRICAL_SAMPLES - 1]
      : undefined;
  const knownTiers = [tier, retainedTier].filter(positive);
  const observedTier = knownTiers.length > 0 ? Math.min(...knownTiers) : undefined;
  const retentionMs = observedTier ?? empirical;
  return {
    invocationId: input.invocationId,
    nativeSessionId: record.cliSessionId,
    runtime: input.runtime,
    model: input.model,
    ...(input.executionBoundaryRef ? { executionBoundaryRef: input.executionBoundaryRef } : {}),
    requestStartedAt: input.requestStartedAt,
    timeSource: 'invocation_start_lower_bound',
    observedAt: input.observedAt,
    contextTokens: input.contextTokens,
    ...(singleRequest &&
    usage.cacheReadTokens !== undefined &&
    Number.isSafeInteger(usage.cacheReadTokens) &&
    usage.cacheReadTokens >= 0 &&
    usage.cacheReadTokens <= input.contextTokens
      ? { cacheReadTokens: usage.cacheReadTokens }
      : {}),
    compressionCount: record.compressionCount,
    ...(retentionMs !== undefined
      ? {
          retentionMs,
          retentionSource: observedTier !== undefined ? 'usage_ttl' : 'empirical_session',
        }
      : {}),
    confirmedWarmGapsMs: boundedSamples,
  };
}

export function projectSessionCacheWarmth(
  record: SessionRecord | null,
  now: number,
  expected?: { model: string; runtime: string },
  maintenance?: CacheRetentionWarmProof,
): SessionCacheWarmth {
  const observation = record?.lastUsage?.cacheObservation;
  const unknown = (reason: string): SessionCacheWarmth => ({
    status: 'unknown',
    estimated: true,
    source: 'unavailable',
    reason,
    ...(record
      ? {
          sessionId: record.id,
          threadId: record.threadId,
          contextTokens: record.contextHealth?.usedTokens,
          lastCompressionAt: record.compressionObservation?.observedAt,
        }
      : {}),
  });
  if (!record || record.status !== 'active' || !observation) return unknown('no_current_observation');
  if (
    record.cliSessionId !== observation.nativeSessionId ||
    record.compressionCount !== observation.compressionCount ||
    (record.compressionObservation?.observedAt ?? 0) > observation.observedAt
  )
    return unknown('session_or_compression_changed');
  if (expected && (expected.model !== observation.model || expected.runtime !== observation.runtime))
    return unknown('runtime_or_model_changed');
  if (
    observation.observedAt > now ||
    observation.requestStartedAt > observation.observedAt ||
    !positive(observation.retentionMs)
  )
    return unknown('no_valid_retention_window');
  const retained = validRetentionProof(record, maintenance) ? maintenance : undefined;
  const expiresAt = retained?.expiresAt ?? observation.requestStartedAt + observation.retentionMs;
  const latestExpiresAt = retained?.expiresAt ?? observation.observedAt + observation.retentionMs;
  // Empirical gaps prove a lower bound; passing that bound does not prove eviction.
  if (expiresAt <= now && observation.retentionSource === 'empirical_session')
    return unknown('outside_observed_window');
  const projection: SessionCacheWarmth = {
    status: expiresAt > now ? 'warm' : 'expired',
    estimated: true,
    source: retained ? 'cache_retention' : (observation.retentionSource ?? 'unavailable'),
    ...(retained
      ? { maintenanceInvocationId: retained.maintenanceInvocationId, retaining: retained.retaining === true }
      : {}),
    sessionId: record.id,
    threadId: record.threadId,
    model: observation.model,
    runtime: observation.runtime,
    contextTokens: observation.contextTokens,
    requestStartedAt: observation.requestStartedAt,
    timeSource: observation.timeSource,
    observedAt: observation.observedAt,
    expiresAt,
    latestExpiresAt,
    ...(record.compressionObservation ? { lastCompressionAt: record.compressionObservation.observedAt } : {}),
  };
  if (expiresAt <= now && latestExpiresAt > now)
    return { ...projection, status: 'unknown', reason: 'invocation_span_uncertain' };
  return projection;
}
