import { type EvolutionProgramEventV1, type OwnerTruthRefV1, ownerTruthRefV1Schema } from '@cat-cafe/shared';
import type { EvolutionProgramProjectionV1 } from './program-projection.js';

export type EvolutionProgramCommandAction =
  | { type: 'pause'; reasonRef: OwnerTruthRefV1 }
  | { type: 'resume'; resumeRef: OwnerTruthRefV1 }
  | {
      type: 'needs_expert';
      missingRole: 'observer' | 'domain_owner' | 'consumer' | 'calibrator';
      blockerRef: OwnerTruthRefV1;
    }
  | { type: 'bind_expert'; roleOwnerRef: OwnerTruthRefV1 }
  | { type: 'withdraw'; decisionRef: OwnerTruthRefV1 }
  | {
      type: 'retention';
      mode: 'keep_forever' | 'forget_after';
      ttlSeconds?: number;
      retentionActionRef: OwnerTruthRefV1;
    }
  | {
      type: 'forget';
      ttlSeconds: number;
      decisionRef: OwnerTruthRefV1;
      retentionActionRef: OwnerTruthRefV1;
    };

export type EvolutionProgramServiceResult =
  | { outcome: 'appended' | 'duplicate'; projection: EvolutionProgramProjectionV1 }
  | { outcome: 'conflict'; actualSequence: number; projection: EvolutionProgramProjectionV1 };

export type EvolutionProgramServiceErrorCode = 'program_not_found' | 'idempotency_collision' | 'invalid_command';

export class EvolutionProgramServiceError extends Error {
  constructor(
    readonly code: EvolutionProgramServiceErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'EvolutionProgramServiceError';
  }
}

export function requirePositiveTtl(ttlSeconds: number | undefined): number {
  if (!Number.isSafeInteger(ttlSeconds) || (ttlSeconds ?? 0) <= 0) {
    throw new EvolutionProgramServiceError('invalid_command', 'forget_after requires a positive ttlSeconds');
  }
  return ttlSeconds as number;
}

export function eventForAction(
  action: Exclude<EvolutionProgramCommandAction, { type: 'forget' }>,
  actorRef: string,
  occurredAt: string,
): EvolutionProgramEventV1 {
  switch (action.type) {
    case 'pause':
      return { type: 'program_paused', reasonRef: ownerTruthRefV1Schema.parse(action.reasonRef) };
    case 'resume':
      return { type: 'program_resumed', resumeRef: ownerTruthRefV1Schema.parse(action.resumeRef) };
    case 'needs_expert':
      return {
        type: 'expert_required',
        missingRole: action.missingRole,
        blockerRef: ownerTruthRefV1Schema.parse(action.blockerRef),
      };
    case 'bind_expert':
      return { type: 'expert_bound', roleOwnerRef: ownerTruthRefV1Schema.parse(action.roleOwnerRef) };
    case 'withdraw':
      return { type: 'program_withdrawn', decisionRef: ownerTruthRefV1Schema.parse(action.decisionRef) };
    case 'retention':
      return {
        type: 'retention_opted_in',
        retention:
          action.mode === 'keep_forever'
            ? { mode: 'keep_forever', optedInBy: actorRef, optedInAt: occurredAt }
            : {
                mode: 'forget_after',
                optedInBy: actorRef,
                optedInAt: occurredAt,
                ttlSeconds: requirePositiveTtl(action.ttlSeconds),
              },
        retentionActionRef: ownerTruthRefV1Schema.parse(action.retentionActionRef),
      };
  }
}
