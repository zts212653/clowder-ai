import type { EvolutionObservationSetupV1, EvolutionProgramEventEnvelopeV1, OwnerTruthRefV1 } from '@cat-cafe/shared';
import type { ProgramObservationBlocker } from './program-join-validator.js';

export interface EvolutionTriggerRegistrationProjection {
  status: 'registered';
  registrationRef: OwnerTruthRefV1;
  domainId: string;
  channels: readonly ['event', 'quota', 'time'];
  policy: {
    mode: 'threshold_or_time';
    eventSource: string;
    threshold: { counter: string; crossingAt: number };
  };
  nextEvaluationAt: string;
}

export interface EvolutionObservationGap {
  code: string;
  message: string;
  ownerFeatureId: string;
  ownerStateRef?: string;
}

export interface EvolutionObservationProjection {
  status: 'connected' | 'insufficient';
  trajectory?: {
    ref: OwnerTruthRefV1;
    invocationId: string;
    threadId: string;
  };
  connectedEyes: Array<{
    sourceKind: string;
    ownerSurfaceRef: OwnerTruthRefV1;
    joinKey: string;
    namedConsumerRef: OwnerTruthRefV1;
    instrumentationRef: OwnerTruthRefV1;
    ownerHref: string;
  }>;
  evidenceProofRefs?: EvolutionObservationSetupV1['evidenceProofRefs'];
  trigger?: EvolutionTriggerRegistrationProjection;
  nextEvaluationAt?: string;
  gaps: EvolutionObservationGap[];
}

const gapMessages: Record<string, string> = {
  trajectory_ref_missing: '尚未连接 F299 canonical invocation trajectory。',
  heterogeneous_owner_surfaces_missing: '尚未连接至少两个异质 owner signal/decision surfaces。',
  trigger_registration_missing: 'F192 event/quota/time trigger registration 不可用。',
  evidence_owner_contract_unavailable: 'F267 owner evidence proof contract 尚不可用。',
  evidence_role_missing: 'F267 evidence role proof 缺失。',
  consumption_proof_missing: 'named consumer consumption proof 缺失。',
  optimizer_exposure_proof_missing: 'optimizer exposure proof 缺失。',
  promotion_holdout_missing: 'sealed 或 time-fresh promotion holdout proof 缺失。',
  promotion_holdout_reuses_evaluation_cohort: 'promotion holdout 复用了 evaluation cohort。',
  promotion_holdout_optimizer_exposed: 'promotion holdout 已暴露给 optimizer。',
  promotion_holdout_not_sealed: 'promotion holdout 未在 optimizer selection 前 sealed。',
  promotion_holdout_not_time_fresh: 'promotion holdout 不晚于 optimizer selection cutoff。',
  trajectory_unresolved: 'F299 invocation trajectory 无法解析。',
  owner_surface_resolver_missing: 'owner surface resolver 未注册。',
  owner_surface_unresolved: 'canonical owner surface join 无法解析。',
  owner_surface_unavailable: 'canonical owner surface 暂时不可用。',
  named_consumer_missing: 'F311 named consumer ref 缺失或不 canonical。',
  instrumentation_proposal_invalid: 'instrumentation proposal ref 未归属对应 source owner。',
};

function gap(code: string, ownerFeatureId: string, ownerStateRef?: string): EvolutionObservationGap {
  return {
    code,
    message: gapMessages[code] ?? code,
    ownerFeatureId,
    ...(ownerStateRef ? { ownerStateRef } : {}),
  };
}

function defaultGaps(registration?: EvolutionTriggerRegistrationProjection): EvolutionObservationGap[] {
  return [
    gap('trajectory_ref_missing', 'F299'),
    gap('heterogeneous_owner_surfaces_missing', 'F311'),
    ...(!registration ? [gap('trigger_registration_missing', 'F192')] : []),
    gap('evidence_role_missing', 'F267'),
    gap('consumption_proof_missing', 'F267'),
    gap('optimizer_exposure_proof_missing', 'F267'),
    gap('promotion_holdout_missing', 'F267'),
  ];
}

function ownerHref(ownerFeatureId: string, joinKey: string): string {
  const separator = joinKey.indexOf(':');
  const kind = joinKey.slice(0, separator);
  const id = joinKey.slice(separator + 1);
  if (ownerFeatureId === 'F278' && kind === 'message') {
    return `/api/paw-feel/source/${encodeURIComponent(id)}`;
  }
  if (ownerFeatureId === 'F281' && kind === 'subject') {
    return `/api/human-disposition-feedback/episodes?subjectRef=${encodeURIComponent(id)}`;
  }
  return '';
}

export function projectEvolutionObservation(
  events: readonly EvolutionProgramEventEnvelopeV1[],
  registration?: EvolutionTriggerRegistrationProjection,
  attemptedBlockers?: readonly ProgramObservationBlocker[],
): EvolutionObservationProjection {
  const linked = [...events].reverse().find((entry) => entry.event.type === 'observation_setup_linked');
  if (linked?.event.type !== 'observation_setup_linked') {
    const gaps =
      attemptedBlockers?.map((blocker) => gap(blocker.code, blocker.ownerFeatureId, blocker.ownerStateRef)) ??
      defaultGaps(registration);
    return {
      status: 'insufficient',
      connectedEyes: [],
      ...(registration ? { trigger: registration, nextEvaluationAt: registration.nextEvaluationAt } : {}),
      gaps,
    };
  }

  const setup = linked.event.setup;
  const invocationId = setup.trajectory.ref.ownerStateRef.slice('inv:'.length);
  const threadId = setup.trajectory.joinKey.slice('thread:'.length);
  return {
    status: 'connected',
    trajectory: { ref: setup.trajectory.ref, invocationId, threadId },
    connectedEyes: setup.sourceBindings.map((binding) => ({
      ...binding,
      ownerHref: ownerHref(binding.ownerSurfaceRef.ownerFeatureId, binding.joinKey),
    })),
    evidenceProofRefs: setup.evidenceProofRefs,
    ...(registration ? { trigger: registration, nextEvaluationAt: registration.nextEvaluationAt } : {}),
    gaps: registration ? [] : [gap('trigger_registration_missing', 'F192')],
  };
}
