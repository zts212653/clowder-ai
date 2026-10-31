import type { FrictionChannel, FrictionRollupInput, FrictionRollupReport } from '@cat-cafe/shared';

export const FRICTION_MEASUREMENT_CHANNELS = [
  'paw-feel',
  'cancel',
  'user-feedback',
  'eval-domain',
] as const satisfies readonly FrictionChannel[];

export interface FrictionChannelCapture {
  status: 'ok' | 'error';
  emittedIds: string[];
  errorCode?: 'source_pull_failed';
}

export interface FrictionMeasurementCapture {
  capturedAt: string;
  expectedCancelIds: string[];
  channelCaptures: Record<FrictionChannel, FrictionChannelCapture>;
  rollupInput: FrictionRollupInput;
  rollupReport: FrictionRollupReport;
}

export type CancelJoinStatus =
  | 'complete'
  | 'adapter_gap'
  | 'unexpected_output'
  | 'mismatch'
  | 'no_opportunity'
  | 'unavailable';

interface MeasuredOpportunity {
  status: 'measured';
  ids: string[];
  provenance: 'frozen_task_outcome_rows';
}

interface UnmeasuredOpportunity {
  status: 'unmeasured';
  ids: null;
  provenance: 'canonical_opportunity_source_not_instrumented';
}

interface FunnelStage {
  ids: string[];
  excludedIds: string[];
  provenance: string;
}

export interface FrictionChannelFunnel {
  opportunity: MeasuredOpportunity | UnmeasuredOpportunity;
  adapter: FrictionChannelCapture & { provenance: 'single_window_adapter_capture' };
  aggregate: FunnelStage;
  clustered: FunnelStage;
  eligibility: FunnelStage;
  actionable: FunnelStage;
}

export interface FrictionMeasurementReport {
  schemaVersion: 1;
  measurementTarget: 'friction_opportunity_to_action';
  window: { sinceMs: number; untilMs: number };
  capturedAt: string;
  baselineKind: 'prospective_paired_capture';
  historicalBaseline: {
    classification: 'symptom_cohort';
    rollupCount: 11;
    limitation: 'historical_rollups_lack_frozen_canonical_row_ids';
  };
  cancelJoin: {
    status: CancelJoinStatus;
    expectedIds: string[];
    actualIds: string[];
    intersectionIds: string[];
    missingIds: string[];
    extraIds: string[];
    recall: number | null;
  };
  channels: Record<FrictionChannel, FrictionChannelFunnel>;
  decision: {
    status: 'usable' | 'insufficient';
    reasons: string[];
    withdrawalConditions: string[];
  };
}

export function buildFrictionMeasurementReport(capture: FrictionMeasurementCapture): FrictionMeasurementReport {
  const expectedIds = sortedUnique(capture.expectedCancelIds);
  const actualIds = sortedUnique(capture.channelCaptures.cancel.emittedIds);
  const cancelAvailable = capture.channelCaptures.cancel.status === 'ok';
  const intersectionIds = cancelAvailable ? intersect(expectedIds, actualIds) : [];
  const missingIds = cancelAvailable ? subtract(expectedIds, actualIds) : [];
  const extraIds = cancelAvailable ? subtract(actualIds, expectedIds) : [];
  const status = cancelAvailable ? classifyCancelJoin(expectedIds, actualIds, missingIds, extraIds) : 'unavailable';
  const reasons = decisionReasons(capture, status);

  return {
    schemaVersion: 1,
    measurementTarget: 'friction_opportunity_to_action',
    window: capture.rollupInput.window,
    capturedAt: capture.capturedAt,
    baselineKind: 'prospective_paired_capture',
    historicalBaseline: {
      classification: 'symptom_cohort',
      rollupCount: 11,
      limitation: 'historical_rollups_lack_frozen_canonical_row_ids',
    },
    cancelJoin: {
      status,
      expectedIds,
      actualIds,
      intersectionIds,
      missingIds,
      extraIds,
      recall: !cancelAvailable || expectedIds.length === 0 ? null : intersectionIds.length / expectedIds.length,
    },
    channels: buildChannelFunnels(capture),
    decision: {
      status: reasons.length === 0 ? 'usable' : 'insufficient',
      reasons,
      withdrawalConditions: withdrawalConditions(capture, status),
    },
  };
}

function buildChannelFunnels(capture: FrictionMeasurementCapture): Record<FrictionChannel, FrictionChannelFunnel> {
  const retained = idsByChannel(capture.rollupInput.signals);
  const clustered = clusterMemberIdsByChannel(capture.rollupInput.clusters);
  const eligibleClusters = capture.rollupInput.clusters.filter((item) =>
    item.channels.some((channel) => channel !== 'eval-domain'),
  );
  const eligible = clusterMemberIdsByChannel(eligibleClusters);
  const actionable = clusterMemberIdsByChannel(capture.rollupReport.actionableCandidates);
  const funnels = {} as Record<FrictionChannel, FrictionChannelFunnel>;

  for (const channel of FRICTION_MEASUREMENT_CHANNELS) {
    const emittedIds = sortedUnique(capture.channelCaptures[channel].emittedIds);
    const retainedIds = retained[channel];
    const clusteredIds = clustered[channel];
    const eligibleIds = eligible[channel];
    const actionableIds = actionable[channel];
    funnels[channel] = {
      opportunity:
        channel === 'cancel'
          ? {
              status: 'measured',
              ids: sortedUnique(capture.expectedCancelIds),
              provenance: 'frozen_task_outcome_rows',
            }
          : {
              status: 'unmeasured',
              ids: null,
              provenance: 'canonical_opportunity_source_not_instrumented',
            },
      adapter: {
        ...capture.channelCaptures[channel],
        emittedIds,
        provenance: 'single_window_adapter_capture',
      },
      aggregate: stage(retainedIds, subtract(emittedIds, retainedIds), 'friction_aggregator_output'),
      clustered: stage(clusteredIds, subtract(retainedIds, clusteredIds), 'friction_cluster_membership'),
      eligibility: stage(eligibleIds, subtract(clusteredIds, eligibleIds), 'non_eval_domain_only_cluster_membership'),
      actionable: stage(actionableIds, subtract(eligibleIds, actionableIds), 'rollup_actionable_candidate_selection'),
    };
  }
  return funnels;
}

function stage(ids: string[], excludedIds: string[], provenance: string): FunnelStage {
  return { ids: sortedUnique(ids), excludedIds: sortedUnique(excludedIds), provenance };
}

function classifyCancelJoin(
  expectedIds: string[],
  actualIds: string[],
  missingIds: string[],
  extraIds: string[],
): CancelJoinStatus {
  if (expectedIds.length === 0 && actualIds.length === 0) return 'no_opportunity';
  if (missingIds.length > 0 && extraIds.length > 0) return 'mismatch';
  if (missingIds.length > 0) return 'adapter_gap';
  if (extraIds.length > 0) return 'unexpected_output';
  return 'complete';
}

function decisionReasons(capture: FrictionMeasurementCapture, status: CancelJoinStatus): string[] {
  const reasons: string[] = [];
  if (status !== 'complete') reasons.push(`cancel_join:${status}`);
  for (const channel of FRICTION_MEASUREMENT_CHANNELS) {
    if (capture.channelCaptures[channel].status === 'error') reasons.push(`adapter_error:${channel}`);
  }
  if (capture.rollupInput.degraded) reasons.push('downstream_degraded');
  return reasons;
}

function withdrawalConditions(capture: FrictionMeasurementCapture, status: CancelJoinStatus): string[] {
  const conditions: string[] = [];
  if (status === 'no_opportunity') conditions.push('rerun_after_closed_window_with_cancel_opportunity');
  else if (status !== 'complete' && status !== 'unavailable') {
    conditions.push('withdraw_until_cancel_id_reconciliation_is_complete');
  }
  for (const channel of FRICTION_MEASUREMENT_CHANNELS) {
    if (capture.channelCaptures[channel].status === 'error') {
      conditions.push(`rerun_after_failed_channel_recovers:${channel}`);
    }
  }
  if (capture.rollupInput.degraded) conditions.push('rerun_after_downstream_dependencies_recover');
  return conditions.length > 0 ? conditions : ['withdraw_if_source_contract_or_window_identity_changes'];
}

function idsByChannel(items: Array<{ id: string; channel: FrictionChannel }>): Record<FrictionChannel, string[]> {
  const result = emptyChannelIds();
  for (const item of items) result[item.channel].push(item.id);
  for (const channel of FRICTION_MEASUREMENT_CHANNELS) result[channel] = sortedUnique(result[channel]);
  return result;
}

function clusterMemberIdsByChannel(
  clusters: Array<{ members: Array<{ signalId: string; channel: FrictionChannel }> }>,
): Record<FrictionChannel, string[]> {
  const result = emptyChannelIds();
  for (const item of clusters) {
    for (const member of item.members) result[member.channel].push(member.signalId);
  }
  for (const channel of FRICTION_MEASUREMENT_CHANNELS) result[channel] = sortedUnique(result[channel]);
  return result;
}

function emptyChannelIds(): Record<FrictionChannel, string[]> {
  return { 'paw-feel': [], cancel: [], 'user-feedback': [], 'eval-domain': [] };
}

function sortedUnique(ids: readonly string[]): string[] {
  return [...new Set(ids)].sort();
}

function intersect(left: readonly string[], right: readonly string[]): string[] {
  const rightSet = new Set(right);
  return sortedUnique(left.filter((id) => rightSet.has(id)));
}

function subtract(left: readonly string[], right: readonly string[]): string[] {
  const rightSet = new Set(right);
  return sortedUnique(left.filter((id) => !rightSet.has(id)));
}
