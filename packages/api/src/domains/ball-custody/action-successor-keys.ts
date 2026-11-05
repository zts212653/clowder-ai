import type { ActionSuccessorIdentityInput } from './action-successor-state-machine.js';
import { canonicalizeActionIdentity, canonicalizeActionSubjectRef } from './action-successor-state-machine.js';

function part(value: string): string {
  return encodeURIComponent(value);
}

export const ActionSuccessorKeys = {
  DETAIL_PREFIX: 'action:successor:detail:',
  ALL: 'action:successor:all',
  RECOVERY_MIGRATION: 'action:successor:recovery-index:v1',
  recoveryDue(lane: 'return' | 'dispatch' | 'task'): string {
    return `action:successor:due:${lane}`;
  },
  recoveryIndexes(): string[] {
    return ['return', 'dispatch', 'task'].map((lane) => `action:successor:due:${lane}`);
  },
  detail(leaseId: string): string {
    return `${this.DETAIL_PREFIX}${part(leaseId)}`;
  },
  identity(input: ActionSuccessorIdentityInput): string {
    const identity = canonicalizeActionIdentity(input);
    return `action:successor:identity:${part(identity.tenantScope)}:${part(identity.subjectRef)}:${part(identity.actionFamily)}:${part(identity.successorSlot)}`;
  },
  subjectTerminal(subjectRef: string): string {
    return `action:successor:subject-terminal:${part(canonicalizeActionSubjectRef(subjectRef))}`;
  },
  subjectTerminalHistory(subjectRef: string): string {
    return `action:successor:subject-terminal-history:${part(canonicalizeActionSubjectRef(subjectRef))}`;
  },
} as const;
