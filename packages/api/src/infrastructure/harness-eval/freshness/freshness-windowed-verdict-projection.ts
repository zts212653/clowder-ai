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
  'metric:freshness.supplement_offered',
  'metric:freshness.supplement_claimed',
  'metric:freshness.supplement_terminal',
  'metric:freshness.supplement_committed',
  'metric:freshness.supplement_declined',
  'metric:freshness.supplement_failed',
  'metric:freshness.supplement_budget_exhausted',
  'metric:freshness.supplement_unresolved_at_window_end',
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
    supplement_offered: replay.windowedSignals.supplements.offeredCount,
    supplement_claimed: replay.windowedSignals.supplements.claimedCount,
    supplement_terminal: replay.windowedSignals.supplements.terminalCount,
    supplement_committed: replay.windowedSignals.supplements.committedCount,
    supplement_declined: replay.windowedSignals.supplements.declinedCount,
    supplement_failed: replay.windowedSignals.supplements.failedCount,
    supplement_budget_exhausted: replay.windowedSignals.supplements.budgetExhaustedCount,
    supplement_unresolved_at_window_end: replay.windowedSignals.supplements.unresolvedAtWindowEndCount,
    gate_held: signalCount(replay, 'held_decision'),
    gate_forward: signalCount(replay, 'forward_decision'),
    notice_attached: signalCount(replay, 'notice_attached'),
    notice_acked: signalCount(replay, 'notice_implicit_acked'),
    notice_deferred: signalCount(replay, 'notice_deferred'),
    reinvoke_triggered: signalCount(replay, 'reinvoke_triggered'),
    reinvoke_skipped: signalCount(replay, 'reinvoke_skipped'),
    stream_stale: signalCount(replay, 'stream_stale_detected'),
    stream_fresh: signalCount(replay, 'stream_fresh'),
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
  friction.supplement_unresolved_at_window_end = replay.windowedSignals.supplements.unresolvedAtWindowEndCount;
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
      supplement_offered: replay.windowedSignals.supplements.offeredCount,
      supplement_terminal: replay.windowedSignals.supplements.terminalCount,
      supplement_committed: replay.windowedSignals.supplements.committedCount,
      supplement_declined: replay.windowedSignals.supplements.declinedCount,
      attention_events: replay.windowedSignals.attention.eventCount,
    },
    frictionCounts: {
      queue_seen_unhandled: replay.windowedSignals.queue.seenUnhandledAtWindowEndCount,
      queue_pending: replay.windowedSignals.queue.pendingAtWindowEndCount,
      supplement_unresolved: replay.windowedSignals.supplements.unresolvedAtWindowEndCount,
      supplement_failed: replay.windowedSignals.supplements.failedCount,
      supplement_budget_exhausted: replay.windowedSignals.supplements.budgetExhaustedCount,
      provider_notice_missed: signalCount(replay, 'provider_notice_missed'),
    },
  };
}
