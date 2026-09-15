import {
  type EvolutionProgramEventEnvelopeV1,
  type EvolutionProgramEventV1,
  type EvolutionProgramStateV1,
  evolutionProgramStateV1Schema,
} from './capability-evolution.js';
import type { OwnerTruthRefV1 } from './capability-evolution-refs.js';

type ProgramCreatedEvent = Extract<EvolutionProgramEventV1, { type: 'program_created' }>;
type ProgramCreatedEnvelope = Omit<EvolutionProgramEventEnvelopeV1, 'event'> & { event: ProgramCreatedEvent };
const refs = (...values: OwnerTruthRefV1[]) => values.map((value) => value.ownerStateRef);

export function initialEvolutionProgramState(envelope: ProgramCreatedEnvelope): EvolutionProgramStateV1 {
  const creation = envelope.event;
  return evolutionProgramStateV1Schema.parse({
    program: {
      schemaVersion: 1,
      programId: envelope.programId,
      workspaceId: creation.workspaceId,
      ...(creation.displayName ? { displayName: creation.displayName } : {}),
      objectRef: creation.objectRef,
      claimRef: creation.claimRef,
      certificates: {},
      measurementRoleRefs: {},
      lifecycle: 'active',
      stage: 'constituting',
      cycle: 1,
      sequence: 1,
      currentAssetVersionRefs: [],
      createdAt: envelope.occurredAt,
      updatedAt: envelope.occurredAt,
    },
    cycles: [
      {
        programId: envelope.programId,
        cycle: 1,
        stage: 'constituting',
        lineageRefIds: refs(creation.objectRef, creation.claimRef),
        openedAt: envelope.occurredAt,
      },
    ],
  });
}
