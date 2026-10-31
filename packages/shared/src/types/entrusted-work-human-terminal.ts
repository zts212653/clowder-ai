import { z } from 'zod';

const boundedRef = z.string().trim().min(1).max(1_000);
const boundedReason = z.string().trim().min(1).max(600);
const revisionSchema = z.number().int().positive();
const timestampSchema = z.number().int().nonnegative().finite();

const taskExecutionReasonSchema = z.enum([
  'unassigned_without_binding',
  'terminal_binding_without_execution',
  'dispatch_pending',
  'exact_parent_running',
  'exact_child_running',
  'binding_source_unavailable',
  'binding_missing_for_assignee',
  'binding_task_mismatch',
  'carrier_generation_mismatch',
  'execution_truth_unavailable',
  'carrier_state_unresolved',
  'ambiguous_task_execution',
  'stale_owner_read',
]);

const taskExecutionBindingSchema = z
  .object({
    leaseId: boundedRef,
    generation: revisionSchema,
    threadId: boundedRef,
    catId: boundedRef,
  })
  .strict();

const taskExecutionRefSchema = z
  .object({
    parentInvocationId: boundedRef,
    childInvocationId: boundedRef.optional(),
  })
  .strict();

const taskExecutionBase = {
  v: z.literal(1),
  scope: z.literal('task_binding'),
  observedAt: timestampSchema,
  taskRef: z
    .object({
      taskId: boundedRef,
      subjectRef: boundedRef,
      ownerRef: boundedRef,
      revision: revisionSchema,
    })
    .strict(),
};

/**
 * Fresh owner-scoped execution truth for one exact Task binding.
 * It intentionally says nothing about whether the surrounding Thread is idle.
 */
export const entrustedWorkTaskExecutionV1Schema = z
  .discriminatedUnion('state', [
    z
      .object({
        ...taskExecutionBase,
        state: z.literal('idle'),
        reasonCode: z.enum(['unassigned_without_binding', 'terminal_binding_without_execution']),
        canConfirmSatisfied: z.literal(true),
        binding: taskExecutionBindingSchema.optional(),
      })
      .strict(),
    z
      .object({
        ...taskExecutionBase,
        state: z.literal('queued'),
        reasonCode: z.literal('dispatch_pending'),
        canConfirmSatisfied: z.literal(false),
        binding: taskExecutionBindingSchema,
      })
      .strict(),
    z
      .object({
        ...taskExecutionBase,
        state: z.literal('running'),
        reasonCode: z.enum(['exact_parent_running', 'exact_child_running']),
        canConfirmSatisfied: z.literal(false),
        binding: taskExecutionBindingSchema,
        execution: taskExecutionRefSchema,
      })
      .strict(),
    z
      .object({
        ...taskExecutionBase,
        state: z.literal('unknown'),
        reasonCode: taskExecutionReasonSchema.exclude([
          'unassigned_without_binding',
          'terminal_binding_without_execution',
          'dispatch_pending',
          'exact_parent_running',
          'exact_child_running',
        ]),
        canConfirmSatisfied: z.literal(false),
        binding: taskExecutionBindingSchema.optional(),
      })
      .strict(),
  ])
  .superRefine((projection, context) => {
    const canonicalSubjectRef = `task:work:${projection.taskRef.taskId}`;
    const canonicalOwnerRef = `task:item:${projection.taskRef.taskId}`;
    if (projection.taskRef.subjectRef !== canonicalSubjectRef || projection.taskRef.ownerRef !== canonicalOwnerRef) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['taskRef'],
        message: 'Task execution coordinates must use the canonical subject and owner refs',
      });
    }
    if (projection.state === 'idle' && projection.reasonCode === 'unassigned_without_binding' && projection.binding) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['binding'],
        message: 'Unassigned idle work cannot carry an execution binding',
      });
    }
  });

export const entrustedWorkHumanDecisionV1Schema = z
  .object({
    v: z.literal(1),
    decisionId: z.string().uuid(),
    expectedRevision: revisionSchema,
    decision: z.discriminatedUnion('state', [
      z.object({ state: z.literal('satisfied') }).strict(),
      z.object({ state: z.literal('cancelled'), reason: boundedReason }).strict(),
    ]),
  })
  .strict();

export const entrustedWorkTaskExecutionStopV1Schema = z
  .object({
    state: z.enum(['not_requested', 'not_running', 'prevented_start', 'stopped', 'not_stopped', 'unknown']),
    reasonCode: z.enum([
      'satisfied_decision',
      'task_binding_idle',
      'queued_binding_retired',
      'exact_tracker_execution_aborted',
      'exact_tracker_execution_missing',
      'exact_tracker_user_mismatch',
      'terminal_binding_still_active',
      'task_execution_unknown',
      'execution_control_unavailable',
    ]),
    executionRefs: z.array(boundedRef).max(8),
  })
  .strict()
  .superRefine((result, context) => {
    if (result.state === 'stopped' && result.executionRefs.length === 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['executionRefs'],
        message: 'A stopped result must name the exact execution that was aborted',
      });
    }
  });

const terminalReceiptDecisionSchema = z.discriminatedUnion('state', [
  z
    .object({
      decisionId: z.string().uuid(),
      state: z.literal('satisfied'),
      actorRef: boundedRef,
      authorityRef: boundedRef,
      decisionRef: boundedRef,
      decidedAt: timestampSchema,
    })
    .strict(),
  z
    .object({
      decisionId: z.string().uuid(),
      state: z.literal('cancelled'),
      actorRef: boundedRef,
      authorityRef: boundedRef,
      decisionRef: boundedRef,
      decidedAt: timestampSchema,
      reason: boundedReason,
    })
    .strict(),
]);

const ownerReadDisposition = (kind: 'cancelled' | 'abandoned') =>
  z
    .object({
      kind: z.literal(kind),
      actorKind: z.enum(['human', 'owner']),
      actorRef: boundedRef,
      authorityRef: boundedRef,
      dispositionRef: boundedRef,
      disposedAt: timestampSchema,
      reason: boundedReason.optional(),
      taskExecution: entrustedWorkTaskExecutionV1Schema.optional(),
    })
    .strict();

/** Terminal Task truth exposed by owner-read without turning cancellation into completion. */
export const entrustedWorkTerminalV1Schema = z.discriminatedUnion('state', [
  z
    .object({
      state: z.literal('satisfied'),
      recordedAt: timestampSchema,
      evidenceRefs: z.array(boundedRef).min(1).max(64),
      confirmation: z
        .object({
          kind: z.literal('human'),
          actorRef: boundedRef,
          authorityRef: boundedRef,
          decisionRef: boundedRef,
          confirmedAt: timestampSchema,
          taskExecution: entrustedWorkTaskExecutionV1Schema,
        })
        .strict()
        .optional(),
    })
    .strict(),
  z
    .object({
      state: z.literal('cancelled'),
      recordedAt: timestampSchema,
      evidenceRefs: z.array(boundedRef).max(64),
      disposition: ownerReadDisposition('cancelled'),
    })
    .strict(),
  z
    .object({
      state: z.literal('abandoned'),
      recordedAt: timestampSchema,
      evidenceRefs: z.array(boundedRef).max(64),
      disposition: ownerReadDisposition('abandoned'),
    })
    .strict(),
]);

/** Immutable Host receipt projected as one user-authored line in the Task's original Thread. */
export const entrustedWorkHumanTerminalReceiptV1Schema = z
  .object({
    v: z.literal(1),
    kind: z.literal('entrusted_work_human_terminal'),
    originalThreadId: boundedRef,
    ownerUserId: boundedRef,
    task: z
      .object({
        taskId: boundedRef,
        subjectRef: boundedRef,
        ownerRef: boundedRef,
        previousRevision: revisionSchema,
        revision: revisionSchema,
      })
      .strict(),
    decision: terminalReceiptDecisionSchema,
    execution: z
      .object({
        before: entrustedWorkTaskExecutionV1Schema,
        stop: entrustedWorkTaskExecutionStopV1Schema,
      })
      .strict(),
    recordedAt: timestampSchema,
  })
  .strict()
  .superRefine((receipt, context) => {
    const canonicalSubjectRef = `task:work:${receipt.task.taskId}`;
    const canonicalOwnerRef = `task:item:${receipt.task.taskId}`;
    if (
      receipt.task.subjectRef !== canonicalSubjectRef ||
      receipt.task.ownerRef !== canonicalOwnerRef ||
      receipt.execution.before.taskRef.taskId !== receipt.task.taskId
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['task'],
        message: 'Terminal receipt must bind one canonical Task across every coordinate',
      });
    }
    if (receipt.task.revision !== receipt.task.previousRevision + 1) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['task', 'revision'],
        message: 'Terminal receipt must describe exactly one Task revision transition',
      });
    }
    if (receipt.decision.actorRef !== `user:${receipt.ownerUserId}`) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['decision', 'actorRef'],
        message: 'Terminal receipt actor must be the authenticated Task owner',
      });
    }
    const expectedDecisionRef = `${canonicalSubjectRef}#human-decision:${receipt.decision.decisionId}`;
    const expectedAuthorityRef = `${canonicalOwnerRef}#human-terminal:${receipt.decision.decisionId}`;
    if (
      receipt.decision.decisionRef !== expectedDecisionRef ||
      receipt.decision.authorityRef !== expectedAuthorityRef
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['decision'],
        message: 'Terminal receipt decision and authority refs must be server-canonical',
      });
    }
    if (receipt.execution.before.taskRef.revision !== receipt.task.previousRevision) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['execution', 'before', 'taskRef', 'revision'],
        message: 'Execution observation must be fenced by the pre-terminal Task revision',
      });
    }
    if (receipt.recordedAt < receipt.decision.decidedAt) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['recordedAt'],
        message: 'Receipt cannot precede the human decision',
      });
    }
    if (receipt.decision.state === 'satisfied' && receipt.execution.stop.state !== 'not_requested') {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['execution', 'stop'],
        message: 'Satisfied decisions never request execution cancellation',
      });
    }
    if (receipt.decision.state === 'satisfied' && receipt.execution.before.state !== 'idle') {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['execution', 'before'],
        message: 'Satisfied receipts require a fresh idle Task-binding observation',
      });
    }
  });

export type EntrustedWorkTaskExecutionV1 = z.infer<typeof entrustedWorkTaskExecutionV1Schema>;
export type EntrustedWorkHumanDecisionV1 = z.infer<typeof entrustedWorkHumanDecisionV1Schema>;
export type EntrustedWorkTaskExecutionStopV1 = z.infer<typeof entrustedWorkTaskExecutionStopV1Schema>;
export type EntrustedWorkHumanTerminalReceiptV1 = z.infer<typeof entrustedWorkHumanTerminalReceiptV1Schema>;
export type EntrustedWorkTerminalV1 = z.infer<typeof entrustedWorkTerminalV1Schema>;
