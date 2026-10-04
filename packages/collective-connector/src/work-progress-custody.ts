import { createHash } from 'node:crypto';
import type { CollectiveSourceIdentity } from '@cat-cafe/shared';
import { prepareReplyOperation, submitReplyOperation } from './outbox-custody.js';
import type { ConnectorPersistence } from './persistence.js';
import type { VerifiedAgent } from './state.js';

export interface CollectiveProgressPurpose {
  readonly source: CollectiveSourceIdentity;
  readonly sourceRef: string;
  readonly resultKey: string;
  readonly taskRevision: number;
  readonly resultRevision: number;
  readonly executionRevision: number;
  readonly assignmentEventId: string;
  readonly authorCatId: string;
  readonly body: string;
}
function progressInput(purpose: CollectiveProgressPurpose) {
  const progressKey = createHash('sha256')
    .update(
      JSON.stringify([
        purpose.sourceRef,
        purpose.resultKey,
        purpose.authorCatId,
        purpose.executionRevision,
        purpose.resultRevision,
        purpose.body.trim(),
      ]),
    )
    .digest('hex');
  return {
    source: purpose.source,
    sourceRef: purpose.sourceRef,
    resultKey: purpose.resultKey,
    workRevision: purpose.taskRevision,
    resultRevision: purpose.resultRevision,
    execution: { revision: purpose.executionRevision, assignmentEventId: purpose.assignmentEventId },
    progressKey,
  };
}
export function prepareProgressOperation(
  persistence: ConnectorPersistence,
  now: () => number,
  purpose: CollectiveProgressPurpose,
) {
  return prepareReplyOperation({ persistence, now, ...progressInput(purpose) });
}
export function submitProgressOperation(input: {
  persistence: ConnectorPersistence;
  now: () => number;
  purpose: CollectiveProgressPurpose;
  operationId: string;
  agent: VerifiedAgent;
  verifyAgent: (agent: VerifiedAgent) => Promise<boolean>;
}) {
  if (input.agent.catId !== input.purpose.authorCatId) throw new Error('Progress author does not match its operation');
  return submitReplyOperation({
    persistence: input.persistence,
    now: input.now,
    ...progressInput(input.purpose),
    operationId: input.operationId,
    body: input.purpose.body,
    agent: input.agent,
    verifyAgent: input.verifyAgent,
  });
}
