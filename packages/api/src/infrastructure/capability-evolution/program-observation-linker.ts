import type {
  EvolutionOwnerSurfaceBindingV1,
  EvolutionProgramEventEnvelopeV1,
  EvolutionProgramEventV1,
  OwnerTruthRefV1,
} from '@cat-cafe/shared';
import type { EvolutionProgramServiceResult } from './program-command-contract.js';
import type { ProgramJoinValidator, ProgramObservationBlocker } from './program-join-validator.js';
import type { EvolutionTriggerRegistrationProjection } from './program-observation-projection.js';
import type { EvolutionProgramProjectionV1 } from './program-projection.js';

export interface ProgramObservationLinkInput {
  programId: string;
  expectedSequence: number;
  clientMessageId: string;
  actorRef: string;
  originRef: string;
  ownerUserId: string;
  trajectoryRef: OwnerTruthRefV1;
  sourceBindings: EvolutionOwnerSurfaceBindingV1[];
  evidenceProofRef: OwnerTruthRefV1;
}

export type EvolutionProgramObservationResult =
  | EvolutionProgramServiceResult
  | {
      outcome: 'insufficient';
      blockers: ProgramObservationBlocker[];
      projection: EvolutionProgramProjectionV1;
    };

interface ProgramObservationLinkDependencies {
  read(programId: string): Promise<EvolutionProgramEventEnvelopeV1[]>;
  project(
    events: readonly EvolutionProgramEventEnvelopeV1[],
    blockers?: readonly ProgramObservationBlocker[],
  ): EvolutionProgramProjectionV1;
  joinValidator?: Pick<ProgramJoinValidator, 'validate'>;
  triggerRegistration?: () => EvolutionTriggerRegistrationProjection | undefined;
  envelope(input: ProgramObservationLinkInput, event: EvolutionProgramEventV1): EvolutionProgramEventEnvelopeV1;
  append(envelope: EvolutionProgramEventEnvelopeV1): Promise<EvolutionProgramServiceResult>;
  dispatch?: (input: {
    programEventId: string;
    previousConnectedOwnerSurfaces: number;
    currentConnectedOwnerSurfaces: number;
  }) => Promise<unknown>;
}

function insufficient(
  deps: ProgramObservationLinkDependencies,
  events: readonly EvolutionProgramEventEnvelopeV1[],
  blockers: ProgramObservationBlocker[],
): EvolutionProgramObservationResult {
  return { outcome: 'insufficient', blockers, projection: deps.project(events, blockers) };
}

export async function linkEvolutionProgramObservation(
  input: ProgramObservationLinkInput,
  deps: ProgramObservationLinkDependencies,
): Promise<EvolutionProgramObservationResult> {
  const events = await deps.read(input.programId);
  const projection = deps.project(events);
  if (input.expectedSequence !== projection.program.sequence) {
    return { outcome: 'conflict', actualSequence: projection.program.sequence, projection };
  }
  const registration = deps.triggerRegistration?.();
  if (!registration) {
    return insufficient(deps, events, [{ code: 'trigger_registration_missing', ownerFeatureId: 'F192' }]);
  }
  const validation = deps.joinValidator
    ? await deps.joinValidator.validate({
        programId: input.programId,
        ownerUserId: input.ownerUserId,
        trajectoryRef: input.trajectoryRef,
        sourceBindings: input.sourceBindings,
        evidenceProofRef: input.evidenceProofRef,
      })
    : {
        status: 'insufficient' as const,
        blockers: [{ code: 'owner_surface_resolver_missing' as const, ownerFeatureId: 'F311' }],
      };
  if (validation.status === 'insufficient') return insufficient(deps, events, validation.blockers);

  const envelope = deps.envelope(input, {
    type: 'observation_setup_linked',
    setup: { ...validation.setup, triggerRef: registration.registrationRef },
  });
  const result = await deps.append(envelope);
  if (result.outcome !== 'conflict' && deps.dispatch) {
    await deps.dispatch({
      programEventId: envelope.eventId,
      previousConnectedOwnerSurfaces: projection.observation.connectedEyes.length,
      currentConnectedOwnerSurfaces: validation.setup.sourceBindings.length,
    });
  }
  return result;
}
