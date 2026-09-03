import {
  type EvolutionProgramEventEnvelopeV1,
  type EvolutionProgramStateV1,
  type OwnerTruthRefV1,
  replayEvolutionProgramEvents,
} from '@cat-cafe/shared';
import type { EvolutionAttributionExplanationV1 } from './attribution-explanation.js';
import { projectEvolutionAttribution } from './program-attribution-projection.js';
import type { ProgramObservationBlocker } from './program-join-validator.js';
import {
  type EvolutionObservationProjection,
  type EvolutionTriggerRegistrationProjection,
  projectEvolutionObservation,
} from './program-observation-projection.js';

export type EvolutionProgramBlockerCode =
  | 'goal_certificate_missing'
  | 'measurement_certificate_missing'
  | 'economic_certificate_missing'
  | 'value_owner_missing'
  | 'observer_missing'
  | 'domain_owner_missing'
  | 'consumer_missing'
  | 'calibrator_missing'
  | 'program_paused'
  | 'expert_required';

export interface EvolutionProgramBlocker {
  code: EvolutionProgramBlockerCode;
  message: string;
  ownerFeatureId: string;
  ownerStateRef?: string;
}

export interface EvolutionProgramProjectionV1 extends EvolutionProgramStateV1 {
  drafts: {
    goal: OwnerTruthRefV1;
    claim: OwnerTruthRefV1;
    measurement: OwnerTruthRefV1;
    economic: OwnerTruthRefV1;
    roles: {
      valueOwner: OwnerTruthRefV1;
      observer: OwnerTruthRefV1;
      domainOwner: OwnerTruthRefV1;
      consumer: OwnerTruthRefV1;
      calibrator: OwnerTruthRefV1;
    };
  };
  blockers: EvolutionProgramBlocker[];
  nextAction: {
    code: 'complete_constitution' | 'resume_program' | 'bind_expert' | 'inspect_history' | 'continue_stage';
    label: string;
  };
  observation: EvolutionObservationProjection;
  /** Null until this Cycle has an attribution; never carried over from a closed Cycle. */
  attribution: EvolutionAttributionExplanationV1 | null;
}

const missingConstitution: Array<{
  code: EvolutionProgramBlockerCode;
  featureId: string;
  message: string;
  present: (state: EvolutionProgramStateV1) => boolean;
}> = [
  {
    code: 'goal_certificate_missing',
    featureId: 'F311',
    message: 'Goal certificate 仍待 value owner 冻结。',
    present: (state) => state.program.certificates.goal !== undefined,
  },
  {
    code: 'measurement_certificate_missing',
    featureId: 'F267',
    message: 'Measurement certificate 仍待 F267/source owner 签发。',
    present: (state) => state.program.certificates.measurement !== undefined,
  },
  {
    code: 'economic_certificate_missing',
    featureId: 'F311',
    message: '经济页仍待 value owner 冻结。',
    present: (state) => state.program.certificates.economic !== undefined,
  },
  {
    code: 'value_owner_missing',
    featureId: 'F311',
    message: '尚未绑定 value owner。',
    present: (state) => state.program.valueOwnerRef !== undefined,
  },
  {
    code: 'observer_missing',
    featureId: 'F267',
    message: '尚未绑定 observer。',
    present: (state) => state.program.measurementRoleRefs.observer !== undefined,
  },
  {
    code: 'domain_owner_missing',
    featureId: 'F267',
    message: '尚未绑定 domain owner。',
    present: (state) => state.program.measurementRoleRefs.domainOwner !== undefined,
  },
  {
    code: 'consumer_missing',
    featureId: 'F267',
    message: '尚未绑定 named consumer。',
    present: (state) => state.program.measurementRoleRefs.consumer !== undefined,
  },
  {
    code: 'calibrator_missing',
    featureId: 'F267',
    message: '尚未绑定 calibrator。',
    present: (state) => state.program.measurementRoleRefs.calibrator !== undefined,
  },
];

function latestExpertBlocker(events: readonly EvolutionProgramEventEnvelopeV1[]): EvolutionProgramBlocker | null {
  const event = [...events].reverse().find((candidate) => candidate.event.type === 'expert_required');
  if (event?.event.type !== 'expert_required') return null;
  return {
    code: 'expert_required',
    message: `当前 claim 缺少合格的 ${event.event.missingRole}，只挂起这条 Program。`,
    ownerFeatureId: event.event.blockerRef.ownerFeatureId,
    ownerStateRef: event.event.blockerRef.ownerStateRef,
  };
}

function projectBlockers(
  state: EvolutionProgramStateV1,
  events: readonly EvolutionProgramEventEnvelopeV1[],
): EvolutionProgramBlocker[] {
  if (state.program.lifecycle === 'terminal') return [];
  if (state.program.lifecycle === 'paused') {
    return [
      {
        code: 'program_paused',
        message: 'Program 已暂停；生命周期与历史仍永久保留。',
        ownerFeatureId: 'F311',
      },
    ];
  }
  if (state.program.lifecycle === 'needs_expert') {
    const blocker = latestExpertBlocker(events);
    return blocker ? [blocker] : [];
  }
  if (state.program.stage !== 'constituting') return [];
  return missingConstitution
    .filter((requirement) => !requirement.present(state))
    .map(({ present: _present, featureId, ...requirement }) => ({
      ...requirement,
      ownerFeatureId: featureId,
    }));
}

function nextAction(
  state: EvolutionProgramStateV1,
  blockers: readonly EvolutionProgramBlocker[],
): EvolutionProgramProjectionV1['nextAction'] {
  if (state.program.lifecycle === 'terminal') return { code: 'inspect_history', label: '查看完整生命周期' };
  if (state.program.lifecycle === 'paused') return { code: 'resume_program', label: '恢复 Program' };
  if (state.program.lifecycle === 'needs_expert') return { code: 'bind_expert', label: '绑定缺失角色' };
  if (blockers.length > 0) return { code: 'complete_constitution', label: '继续自动建制' };
  return { code: 'continue_stage', label: '继续当前阶段' };
}

export function projectEvolutionProgram(
  events: readonly EvolutionProgramEventEnvelopeV1[],
  options: {
    triggerRegistration?: EvolutionTriggerRegistrationProjection;
    observationBlockers?: readonly ProgramObservationBlocker[];
  } = {},
): EvolutionProgramProjectionV1 | undefined {
  const state = replayEvolutionProgramEvents(events);
  if (!state) return undefined;
  const programId = state.program.programId;
  const blockers = projectBlockers(state, events);
  return {
    ...state,
    drafts: {
      goal: { ownerFeatureId: 'F311', ownerStateRef: `evolution-goal-draft:${programId}` },
      claim: state.program.claimRef,
      measurement: { ownerFeatureId: 'F267', ownerStateRef: `evolution-measurement-draft:${programId}` },
      economic: { ownerFeatureId: 'F311', ownerStateRef: `evolution-economic-draft:${programId}` },
      roles: {
        valueOwner: { ownerFeatureId: 'F311', ownerStateRef: `evolution-role-draft:${programId}:value-owner` },
        observer: { ownerFeatureId: 'F267', ownerStateRef: `evolution-role-draft:${programId}:observer` },
        domainOwner: { ownerFeatureId: 'F267', ownerStateRef: `evolution-role-draft:${programId}:domain-owner` },
        consumer: { ownerFeatureId: 'F267', ownerStateRef: `evolution-role-draft:${programId}:consumer` },
        calibrator: { ownerFeatureId: 'F267', ownerStateRef: `evolution-role-draft:${programId}:calibrator` },
      },
    },
    blockers,
    nextAction: nextAction(state, blockers),
    observation: projectEvolutionObservation(events, options.triggerRegistration, options.observationBlockers),
    attribution: projectEvolutionAttribution(events),
  };
}
