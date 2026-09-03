import { createHash } from 'node:crypto';
import type { EvaluationOwnerResolver } from './program-evaluation-contract.js';
import type { IEvolutionProgramEventLog } from './program-event-log.js';
import type { ProgramJoinValidator } from './program-join-validator.js';
import type { EvolutionTriggerDispatch } from './program-lifecycle-linker.js';
import type { EvolutionTriggerRegistrationProjection } from './program-observation-projection.js';

/**
 * What the Program service is allowed to depend on.
 *
 * Every owner-side capability is optional, and absent means "fail closed" rather than "assume the
 * happy path": without the F267 resolver the evaluation ingress refuses, and without the F192
 * dispatch lanes the Program can neither open a round nor fire an observation trigger on its own
 * authority.
 */
export interface EvolutionProgramServiceOptions {
  eventLog: IEvolutionProgramEventLog;
  now?: () => string;
  joinValidator?: Pick<ProgramJoinValidator, 'validate'>;
  triggerRegistration?: () => EvolutionTriggerRegistrationProjection | undefined;
  /** F267 measurement owner contract. Absent = the Phase 3 ingress fails closed. */
  evaluationOwnerResolver?: EvaluationOwnerResolver;
  dispatchObservationTrigger?: (input: {
    programEventId: string;
    previousConnectedOwnerSurfaces: number;
    currentConnectedOwnerSurfaces: number;
  }) => Promise<unknown>;
  /**
   * F192's dispatch lane for opening an evaluation round. Absent = the Program cannot open a round
   * at all, which is the safe direction: it must never start one on its own authority.
   */
  dispatchEvaluationTrigger?: (context: { programId: string }) => Promise<EvolutionTriggerDispatch>;
}

export interface CommandBase {
  programId: string;
  expectedSequence: number;
  clientMessageId: string;
  actorRef: string;
  originRef: string;
}

export function stableId(prefix: string, ...parts: string[]): string {
  const digest = createHash('sha256').update(parts.join('\0')).digest('hex').slice(0, 32);
  return `${prefix}:${digest}`;
}
