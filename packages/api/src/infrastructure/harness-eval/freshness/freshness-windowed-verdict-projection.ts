import type { FreshnessAttentionEvent } from '../../../domains/cats/services/freshness/FreshnessAttentionEventLog.js';
import type { FreshnessReplayBundle } from './freshness-replay-types.js';

export const FRESHNESS_WINDOWED_METRIC_REFS = [
  'metric:freshness.queue_admitted',
  'metric:freshness.queued_seen',
  'metric:freshness.queued_handled',
  'metric:freshness.queue_withdrawn',
  'metric:freshness.queue_failed',
  'metric:freshness.queue_seen_unhandled_at_window_end',
  'metric:freshness.queue_pending_at_window_end',
  'metric:freshness.gate_held',
  'metric:freshness.gate_forward',
  'metric:freshness.notice_attached',
  'metric:freshness.notice_acked',
  'metric:freshness.notice_deferred',
  'metric:freshness.reinvoke_triggered',
  'metric:freshness.reinvoke_skipped',
  'metric:freshness.stream_stale',
  'metric:freshness.stream_fresh',
  'metric:freshness.provider_notice_opportunity',
  'metric:freshness.provider_notice_prepared',
  'metric:freshness.provider_notice_delivered',
  'metric:freshness.provider_notice_seen',
  'metric:freshness.provider_notice_handled',
  'metric:freshness.provider_notice_missed',
  'metric:freshness.provider_protocol_observed',
] as const;

export function signalCount(replay: FreshnessReplayBundle, kind: FreshnessAttentionEvent['kind']): number {
  return replay.windowedSignals.attention.counts[kind] ?? 0;
}

export function windowedTrendMetrics(replay: FreshnessReplayBundle): Record<string, number> {
  return {
    queue_admitted: replay.windowedSignals.queue.admittedCount,
    queued_seen: replay.windowedSignals.queue.seenCount,
    queued_handled: replay.windowedSignals.queue.handledCount,
    queue_withdrawn: replay.windowedSignals.queue.withdrawnCount,
    queue_failed: replay.windowedSignals.queue.failedCount,
    queue_seen_unhandled_at_window_end: replay.windowedSignals.queue.seenUnhandledAtWindowEndCount,
    queue_pending_at_window_end: replay.windowedSignals.queue.pendingAtWindowEndCount,
    provider_notice_opportunity: signalCount(replay, 'provider_notice_opportunity'),
    provider_notice_prepared: signalCount(replay, 'provider_notice_prepared'),
    provider_notice_delivered: signalCount(replay, 'provider_notice_delivered'),
    provider_notice_seen: signalCount(replay, 'provider_notice_seen'),
    provider_notice_handled: signalCount(replay, 'provider_notice_handled'),
    provider_notice_missed: signalCount(replay, 'provider_notice_missed'),
    provider_protocol_observed: signalCount(replay, 'provider_protocol_item_observed'),
  };
}

export function addWindowedSnapshotCounts(
  replay: FreshnessReplayBundle,
  activation: Record<string, number>,
  friction: Record<string, number>,
): void {
  activation.windowed_observations = replay.windowedSignals.observedActivityCount;
  Object.assign(activation, windowedTrendMetrics(replay));
  friction.queue_seen_unhandled_at_window_end = replay.windowedSignals.queue.seenUnhandledAtWindowEndCount;
  friction.queue_pending_at_window_end = replay.windowedSignals.queue.pendingAtWindowEndCount;
}

export function windowedSignalComponent(replay: FreshnessReplayBundle) {
  return {
    id: 'freshness-windowed-signal-plane',
    name: 'F254 owner-scoped Queue, Supplement, gate, notice, and reinvoke signals',
    confidence: 'high',
    activationCounts: {
      observations: replay.windowedSignals.observedActivityCount,
      queue_entry_targets: replay.windowedSignals.queue.entryTargetCount,
      queued_seen: replay.windowedSignals.queue.seenCount,
      queued_handled: replay.windowedSignals.queue.handledCount,
      attention_events: replay.windowedSignals.attention.eventCount,
    },
    frictionCounts: {
      queue_seen_unhandled: replay.windowedSignals.queue.seenUnhandledAtWindowEndCount,
      queue_pending: replay.windowedSignals.queue.pendingAtWindowEndCount,
      provider_notice_missed: signalCount(replay, 'provider_notice_missed'),
    },
  };
}
