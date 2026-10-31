import { describe, expect, it } from 'vitest';
import {
  entrustedWorkHumanDecisionV1Schema,
  entrustedWorkHumanTerminalReceiptV1Schema,
  entrustedWorkTaskExecutionV1Schema,
} from '../types/entrusted-work-human-terminal.js';
import { entrustedWorkOwnerReadV1Schema } from '../types/entrusted-work-owner-read.js';
import { entrustedWorkV1Schema } from '../types/growing.js';

const idleExecution = {
  v: 1 as const,
  scope: 'task_binding' as const,
  state: 'idle' as const,
  reasonCode: 'unassigned_without_binding' as const,
  canConfirmSatisfied: true,
  observedAt: 1_791_772_000_000,
  taskRef: {
    taskId: 'task-a',
    subjectRef: 'task:work:task-a',
    ownerRef: 'task:item:task-a',
    revision: 3,
  },
};

const cancelledReceipt = {
  v: 1 as const,
  kind: 'entrusted_work_human_terminal' as const,
  originalThreadId: 'thread-a',
  ownerUserId: 'operator',
  task: {
    taskId: 'task-a',
    subjectRef: 'task:work:task-a',
    ownerRef: 'task:item:task-a',
    previousRevision: 3,
    revision: 4,
  },
  decision: {
    decisionId: 'b5e80c62-2a8c-4554-8e72-9cf22ac0214a',
    state: 'cancelled' as const,
    actorRef: 'user:operator',
    authorityRef: 'task:item:task-a#human-terminal:b5e80c62-2a8c-4554-8e72-9cf22ac0214a',
    decisionRef: 'task:work:task-a#human-decision:b5e80c62-2a8c-4554-8e72-9cf22ac0214a',
    decidedAt: 1_791_772_000_010,
    reason: 'This work is no longer needed',
  },
  execution: {
    before: idleExecution,
    stop: {
      state: 'not_running' as const,
      reasonCode: 'task_binding_idle' as const,
      executionRefs: [],
    },
  },
  recordedAt: 1_791_772_000_020,
};

describe('F310 human terminal contract', () => {
  it('accepts only a decision id, exact revision, and bounded human choice from the client', () => {
    const input = {
      v: 1 as const,
      decisionId: 'b5e80c62-2a8c-4554-8e72-9cf22ac0214a',
      expectedRevision: 3,
      decision: { state: 'cancelled' as const, reason: 'This work is no longer needed' },
    };

    expect(entrustedWorkHumanDecisionV1Schema.parse(input)).toEqual(input);
    expect(
      entrustedWorkHumanDecisionV1Schema.safeParse({
        ...input,
        actorRef: 'user:forged',
        evidenceRefs: ['task:work:task-a'],
      }).success,
    ).toBe(false);
    expect(
      entrustedWorkHumanDecisionV1Schema.safeParse({
        ...input,
        decision: { state: 'cancelled', reason: '   ' },
      }).success,
    ).toBe(false);
  });

  it('makes Task binding scope and confirmation eligibility structural', () => {
    expect(entrustedWorkTaskExecutionV1Schema.parse(idleExecution)).toEqual(idleExecution);
    expect(
      entrustedWorkTaskExecutionV1Schema.safeParse({ ...idleExecution, scope: 'thread', state: 'idle' }).success,
    ).toBe(false);
    expect(entrustedWorkTaskExecutionV1Schema.safeParse({ ...idleExecution, canConfirmSatisfied: false }).success).toBe(
      false,
    );

    const running = {
      ...idleExecution,
      state: 'running' as const,
      reasonCode: 'exact_child_running' as const,
      canConfirmSatisfied: false,
      binding: {
        leaseId: 'lease-task-a',
        generation: 2,
        threadId: 'thread-a',
        catId: 'codex-sol',
      },
      execution: { parentInvocationId: 'inv-parent', childInvocationId: 'inv-child' },
    };
    expect(entrustedWorkTaskExecutionV1Schema.parse(running)).toEqual(running);
    expect(entrustedWorkTaskExecutionV1Schema.safeParse({ ...running, execution: undefined }).success).toBe(false);
  });

  it('binds a receipt to one owner, original Thread, Task revision edge, and server decision', () => {
    expect(entrustedWorkHumanTerminalReceiptV1Schema.parse(cancelledReceipt)).toEqual(cancelledReceipt);
    expect(
      entrustedWorkHumanTerminalReceiptV1Schema.safeParse({
        ...cancelledReceipt,
        task: { ...cancelledReceipt.task, subjectRef: 'task:work:other-task' },
      }).success,
    ).toBe(false);
    expect(
      entrustedWorkHumanTerminalReceiptV1Schema.safeParse({
        ...cancelledReceipt,
        decision: { ...cancelledReceipt.decision, actorRef: 'user:someone-else' },
      }).success,
    ).toBe(false);
  });

  it('stores server-stamped human confirmation or cancellation reason on Task owner truth', () => {
    const base = {
      revision: 4,
      admission: {
        basis: 'explicit_entrustment' as const,
        sourceRefs: ['message:source'],
        idempotencyKey: 'source#custody',
        receiptRef: 'task:receipt:source:1',
        admittedAt: 1,
      },
      intendedOutcome: 'A finished result',
      time: {},
      artifactRefs: [],
    };
    const confirmation = {
      kind: 'human' as const,
      actorRef: 'user:operator',
      authorityRef: cancelledReceipt.decision.authorityRef,
      decisionRef: cancelledReceipt.decision.decisionRef,
      confirmedAt: cancelledReceipt.decision.decidedAt,
      taskExecution: idleExecution,
    };
    expect(
      entrustedWorkV1Schema.safeParse({
        ...base,
        closure: {
          condition: 'The owner confirms completion',
          expectedSignal: 'human_confirmation',
          state: 'satisfied',
          evidenceRefs: [confirmation.decisionRef],
          confirmation,
        },
      }).success,
    ).toBe(true);
    expect(
      entrustedWorkV1Schema.safeParse({
        ...base,
        closure: {
          condition: 'The owner confirms completion',
          expectedSignal: 'human_confirmation',
          state: 'satisfied',
          evidenceRefs: [confirmation.decisionRef],
          confirmation: {
            ...confirmation,
            taskExecution: {
              ...idleExecution,
              state: 'unknown',
              reasonCode: 'execution_truth_unavailable',
              canConfirmSatisfied: false,
            },
          },
        },
      }).success,
    ).toBe(false);
    expect(
      entrustedWorkV1Schema.safeParse({
        ...base,
        closure: {
          condition: 'The work remains wanted',
          expectedSignal: 'owner_interest',
          state: 'cancelled',
          evidenceRefs: [cancelledReceipt.decision.decisionRef],
          disposition: {
            kind: 'cancelled',
            actorKind: 'human',
            actorRef: 'user:operator',
            authorityRef: cancelledReceipt.decision.authorityRef,
            dispositionRef: cancelledReceipt.decision.decisionRef,
            disposedAt: cancelledReceipt.decision.decidedAt,
            reason: cancelledReceipt.decision.reason,
          },
        },
      }).success,
    ).toBe(true);
  });

  it('projects cancelled history as inert terminal truth rather than completed work', () => {
    const ownerRead = {
      envelope: {
        subjectRef: 'task:work:task-a',
        ownerRef: 'task:item:task-a',
        admissionReceiptRef: 'task:receipt:task-a:1',
        sourceRefs: ['message:source'],
        revision: 4,
        freshness: { state: 'current' as const, observedRevision: 4 },
        visibility: { ownerUserId: 'operator', human: true, cat: true },
      },
      brief: {
        outcome: {
          state: 'known' as const,
          value: 'A finished result',
          ownerRef: 'task:item:task-a',
          revision: 4,
        },
        current: { state: 'done' as const, ownerRef: 'task:item:task-a', revision: 4 },
        verifiedMilestone: {
          kind: 'work_cancelled' as const,
          evidenceRef: cancelledReceipt.decision.decisionRef,
          revision: 4,
        },
        nextOwner: { kind: 'unknown' as const },
        needsMe: { state: 'not_needed' as const, evidenceRef: 'task:item:task-a', revision: 4 },
      },
      work: {
        title: 'Task A',
        ownerCatId: 'codex-sol',
        threadId: 'thread-a',
        admittedAt: 1,
        ownerNote: '',
      },
      terminal: {
        state: 'cancelled' as const,
        recordedAt: cancelledReceipt.decision.decidedAt,
        evidenceRefs: [cancelledReceipt.decision.decisionRef],
        disposition: {
          kind: 'cancelled' as const,
          actorKind: 'human' as const,
          actorRef: 'user:operator',
          authorityRef: cancelledReceipt.decision.authorityRef,
          dispositionRef: cancelledReceipt.decision.decisionRef,
          disposedAt: cancelledReceipt.decision.decidedAt,
          reason: cancelledReceipt.decision.reason,
        },
      },
      timeRefs: [],
      attentionReceipts: [],
    };

    expect(entrustedWorkOwnerReadV1Schema.safeParse(ownerRead).success).toBe(true);
    expect(
      entrustedWorkOwnerReadV1Schema.safeParse({
        ...ownerRead,
        completion: { recordedAt: 1, evidenceRefs: [cancelledReceipt.decision.decisionRef] },
      }).success,
    ).toBe(false);
    expect(
      entrustedWorkOwnerReadV1Schema.safeParse({
        ...ownerRead,
        brief: {
          ...ownerRead.brief,
          verifiedMilestone: {
            kind: 'work_completed',
            evidenceRef: 'task:item:task-a',
            revision: 4,
          },
        },
      }).success,
    ).toBe(false);
    expect(
      entrustedWorkOwnerReadV1Schema.safeParse({
        ...ownerRead,
        execution: {
          ...idleExecution,
          taskRef: { ...idleExecution.taskRef, revision: 4 },
        },
      }).success,
    ).toBe(false);
    expect(
      entrustedWorkOwnerReadV1Schema.safeParse({
        ...ownerRead,
        terminal: {
          ...ownerRead.terminal,
          disposition: {
            ...ownerRead.terminal.disposition,
            taskExecution: {
              ...idleExecution,
              taskRef: {
                ...idleExecution.taskRef,
                taskId: 'task-other',
                subjectRef: 'task:work:task-other',
                ownerRef: 'task:item:task-other',
              },
            },
          },
        },
      }).success,
    ).toBe(false);
  });

  it('accepts fresh Task execution truth only when its Task coordinates match the owner read', () => {
    const active = {
      envelope: {
        subjectRef: 'task:work:task-a',
        ownerRef: 'task:item:task-a',
        admissionReceiptRef: 'task:receipt:task-a:1',
        sourceRefs: ['message:source'],
        revision: 3,
        freshness: { state: 'current' as const, observedRevision: 3 },
        visibility: { ownerUserId: 'operator', human: true, cat: true },
      },
      brief: {
        outcome: { state: 'known' as const, value: 'Task A', ownerRef: 'task:item:task-a', revision: 3 },
        current: { state: 'doing' as const, ownerRef: 'task:item:task-a', revision: 3 },
        verifiedMilestone: { kind: 'custody_admitted' as const, evidenceRef: 'task:receipt:task-a:1', revision: 3 },
        nextOwner: { kind: 'cat' as const, ownerRef: 'cat:codex-sol', evidenceRef: 'task:item:task-a', revision: 3 },
        needsMe: { state: 'not_needed' as const, evidenceRef: 'task:item:task-a', revision: 3 },
      },
      work: {
        title: 'Task A',
        ownerCatId: 'codex-sol',
        threadId: 'thread-a',
        admittedAt: 1,
        ownerNote: '',
      },
      execution: idleExecution,
      timeRefs: [],
      attentionReceipts: [],
    };
    expect(entrustedWorkOwnerReadV1Schema.safeParse(active).success).toBe(true);
    expect(
      entrustedWorkOwnerReadV1Schema.safeParse({
        ...active,
        execution: {
          ...idleExecution,
          taskRef: {
            ...idleExecution.taskRef,
            taskId: 'other',
            subjectRef: 'task:work:other',
            ownerRef: 'task:item:other',
          },
        },
      }).success,
    ).toBe(false);
  });
});
