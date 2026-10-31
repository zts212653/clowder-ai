import type {
  ContentModificationAcceptance,
  ContentModificationRecord,
  ContentModificationRejection,
  ContentTextProposal,
  ContentWritebackReceipt,
} from '@cat-cafe/shared';
import type { PersistedQueueDeliveryPort } from '../../src/domains/cats/services/agents/invocation/PersistedQueueDelivery.js';
import type { StoredMessage } from '../../src/domains/cats/services/stores/ports/MessageStore.js';

export const requestId = `f309-modification-${'a'.repeat(64)}`;
const revision = `sha256:${'b'.repeat(64)}`;

export function record(
  overrides: {
    requestId?: string;
    taskId?: string;
    sourceVisibility?: { visibility: 'public' | 'whisper'; whisperTo?: readonly string[] };
  } = {},
): ContentModificationRecord {
  return {
    requestId: overrides.requestId ?? requestId,
    ownerUserId: 'operator',
    payload: {
      operationId: '11111111-1111-4111-8111-111111111111',
      targetCatId: 'codex-astra',
      threadId: 'thread-1',
      source: {
        kind: 'workspace',
        locator: { worktreeId: 'work', path: 'guide.md' },
        expectedSourceRevision: revision,
        reviewId: 'review-1',
        expectedReviewRevision: 1,
      },
      intent: { body: 'Please revise this.' },
    },
    progress: {
      sourceMessageId: 'human-message-1',
      sourceMessageRevision: `sha256:${'c'.repeat(64)}`,
      sourceKind: 'human_message',
      ...(overrides.sourceVisibility ? { sourceVisibility: overrides.sourceVisibility } : {}),
      prepared: { kind: 'text', reviewId: 'review-1', sourceRevision: revision },
      task: { taskId: overrides.taskId ?? 'task-open', revision: 1, receiptRef: 'task-receipt-1' },
      review: { reviewId: 'review-1', receiptRef: `${requestId}#request` },
    },
    revision: 5,
    createdAt: 100,
    updatedAt: 200,
  };
}

export function proposal(): ContentTextProposal {
  return {
    proposalRef: 'content-patch:request:1',
    requestId,
    revision: 1,
    operationId: '22222222-2222-4222-8222-222222222222',
    baseRevision: revision,
    resultRevision: `sha256:${'d'.repeat(64)}`,
    edits: [{ selectionId: 'selection-1', start: 0, end: 1, expectedText: 'a', replacement: 'b' }],
    response: 'Done.',
    authorCatId: 'codex-astra',
    createdAt: 300,
    receiptRef: 'content-patch:request:1#prepared',
  };
}

export function rejection(): ContentModificationRejection {
  return {
    requestId,
    candidateRef: proposal().proposalRef,
    ownerUserId: 'operator',
    actorId: 'operator',
    receiptRef: 'f309-rejection:1',
    state: 'rejected',
    rejectedAt: 400,
  };
}

export function acceptance(receiptRef: string): ContentModificationAcceptance {
  return {
    requestId,
    ownerUserId: 'operator',
    acceptOperationId: '33333333-3333-4333-8333-333333333333',
    candidateRef: proposal().proposalRef,
    baseRevision: revision,
    locator: { worktreeId: 'work', path: 'guide.md' },
    humanReceiptRef: `${receiptRef}#human-accepted`,
    fileReceiptRef: receiptRef,
    acceptedAt: 500,
  };
}

export function writeback(state: 'applied' | 'conflict' | 'unknown', receiptRef: string): ContentWritebackReceipt {
  return {
    receiptRef,
    ownerUserId: 'operator',
    locator: { worktreeId: 'work', path: 'guide.md' },
    baseRevision: revision,
    candidateRevision: `sha256:${'d'.repeat(64)}`,
    requestId,
    candidateRef: proposal().proposalRef,
    acceptOperationId: '33333333-3333-4333-8333-333333333333',
    state,
    ...(state === 'applied' ? { appliedAt: 550, writtenRevision: `sha256:${'d'.repeat(64)}` } : {}),
    currentRevision: state === 'conflict' ? `sha256:${'e'.repeat(64)}` : revision,
  };
}

export function openTask(taskId = 'task-open', ownerCatId = 'codex-astra', status = 'todo') {
  return {
    id: taskId,
    userId: 'operator',
    threadId: 'thread-1',
    ownerCatId,
    status,
    entrustedWork: { closure: { state: status === 'done' ? 'completed' : 'open' } },
  };
}

export function wakeMessage(input: Parameters<PersistedQueueDeliveryPort['deliver']>[0]): StoredMessage {
  return {
    id: 'wake-1',
    userId: input.ownerUserId,
    threadId: input.threadId,
    catId: null,
    content: input.content,
    mentions: [input.targetCatId as StoredMessage['mentions'][number]],
    timestamp: 500,
    source: input.source,
  };
}
