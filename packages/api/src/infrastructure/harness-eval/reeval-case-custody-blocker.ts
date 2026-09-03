import type { TaskItem } from '@cat-cafe/shared';
import type { ActionSuccessorLease } from '../../domains/ball-custody/action-successor-state-machine.js';
import type { ReevalCaseTaskDispatchResult } from './reeval-case-task-dispatch.js';
import type { IReevalClosureEventLog, ReevalClosureAppendResult } from './reeval-closure-event-log.js';
import type { ReevalCaseReconcileSubject } from './reeval-closure-reconciler.js';

export type ReevalCaseCustodyDispatchStage = 'responsibility' | 'reevaluation';

interface AppendCustodyDispatchBlockerInput {
  eventLog: Pick<IReevalClosureEventLog, 'append'>;
  subject: ReevalCaseReconcileSubject;
  activeVerdictId: string;
  stage: ReevalCaseCustodyDispatchStage;
  task: TaskItem;
  lease: ActionSuccessorLease;
  dispatch: Extract<ReevalCaseTaskDispatchResult, { outcome: 'blocked' }>;
  occurredAt: string;
}

export function appendCustodyDispatchBlocker({
  eventLog,
  subject,
  activeVerdictId,
  stage,
  task,
  lease,
  dispatch,
  occurredAt,
}: AppendCustodyDispatchBlockerInput): Promise<ReevalClosureAppendResult> {
  const refs = [
    { kind: 'task' as const, availability: 'available' as const, value: `task:${task.id}` },
    {
      kind: 'other' as const,
      availability: 'available' as const,
      value: `action-successor:${lease.leaseId}:${lease.generation}`,
    },
    ...(dispatch.messageId
      ? [{ kind: 'message' as const, availability: 'available' as const, value: `message:${dispatch.messageId}` }]
      : []),
  ];
  return eventLog.append(
    {
      eventId: `f266:${subject.caseRoot.caseId}:cycle:${activeVerdictId}:custody-dispatch-blocked:${stage}:${lease.generation}:${dispatch.reasonCode}`,
      caseId: subject.caseRoot.caseId,
      verdictId: activeVerdictId,
      domainId: subject.caseRoot.domainId,
      type: 'custody_dispatch_blocked',
      actor: { kind: 'automation', id: 'eval-verdict-closure-reconciler' },
      occurredAt,
      reason: 'durable task and lease exist, but executable custody transport is not yet available; retry in place',
      refs,
      stage,
      reasonCode: dispatch.reasonCode,
      taskId: task.id,
      leaseId: lease.leaseId,
      leaseGeneration: lease.generation,
      ...(dispatch.messageId ? { carrierMessageId: dispatch.messageId } : {}),
    },
    subject.events.length,
  );
}
