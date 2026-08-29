import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it, mock } from 'node:test';

const { ActionSuccessorProjectionRetirementService } = await import(
  '../dist/domains/ball-custody/ActionSuccessorProjectionRetirementService.js'
);
const { canonicalizeActionTerminalPredicate } = await import(
  '../dist/domains/ball-custody/ActionTerminalPredicateCatalog.js'
);
const { claimActionSuccessor, commitActionCompletionVerdict, recordActionCompletionCandidate } = await import(
  '../dist/domains/ball-custody/action-successor-state-machine.js'
);
const { TaskStore } = await import('../dist/domains/cats/services/stores/ports/TaskStore.js');

const HEAD_A = 'ea25d80245c73b0c396d55ecd9f80615122e3401';
const HEAD_B = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

function completedLease() {
  const terminalPredicate = canonicalizeActionTerminalPredicate({
    actionFamily: 'review',
    subjectRef: 'pr:zts212653/clowder-ai#1391',
    predicate: { kind: 'review_delivered', headSha: HEAD_A },
  });
  const claimed = claimActionSuccessor(null, {
    leaseId: '52752674-4234-4f23-97fd-8bcb25c86025',
    tenantScope: 'default-user',
    subjectRef: 'pr:zts212653/clowder-ai#1391',
    actionFamily: 'review',
    successorSlot: 'reviewer',
    mode: 'single',
    holderCatIds: ['codex-sol'],
    dispatchId: 'cross-post:f300-pr1391-replace-gen3-v1',
    claimOrigin: 'structured_transfer',
    holderThreadId: 'thread_mp3ab0r9xqxrkrc5',
    predecessorCatId: 'fable-5',
    predecessorThreadId: 'thread_msue27hp8grwfwwj',
    issuerStandingEvidenceRef: 'message:review-request',
    evidenceRefs: ['message:review-request'],
    terminalPredicate,
    now: 100,
  }).lease;
  const candidate = recordActionCompletionCandidate(claimed, {
    generation: 1,
    catId: 'codex-sol',
    evidenceRefs: ['community:pr:zts212653/clowder-ai#1391:review:approved'],
    now: 110,
  });
  const snapshot = candidate.completionCandidates['codex-sol'];
  const completed = commitActionCompletionVerdict(candidate, {
    generation: 1,
    catId: 'codex-sol',
    verdict: {
      status: 'verified',
      evidenceRef: snapshot.evidenceRefs[0],
      predicateDigest: terminalPredicate.digest,
      freshnessKey: terminalPredicate.freshnessKey,
      candidateRevision: snapshot.candidateRevision,
      evidenceDigest: snapshot.evidenceDigest,
    },
    now: 120,
  });
  return { ...completed, dispatchDeliveryState: 'delivered', dispatchDeliveredMessageId: 'message-1391' };
}

function activeWaitState(headSha) {
  return {
    ci: { headSha, lastFingerprint: `${headSha}:success` },
    review: { lastDecisionCursor: 1391 },
    await: {
      v: 1,
      generation: 4,
      subjectRef: 'pr:zts212653/clowder-ai#1391',
      ownerFence: { kind: 'containing_task', generation: 4 },
      baseline: { capturedAt: 100, headSha },
      continuation: {
        when: [{ kind: 'pr_head_changed' }],
        // biome-ignore lint/suspicious/noThenProperty: F280 contract field.
        then: 'Review the fresh HEAD.',
      },
      expiresAt: 10_000,
      createdAt: 100,
      provenance: 'explicit_registration',
    },
  };
}

async function createTrackingTask(taskStore, headSha = HEAD_A) {
  return taskStore.create({
    kind: 'pr_tracking',
    subjectKey: 'pr:zts212653/clowder-ai#1391',
    threadId: 'thread_mp3ab0r9xqxrkrc5',
    title: 'Review #1391',
    why: 'exact-HEAD review wait',
    ownerCatId: 'codex-sol',
    userId: 'default-user',
    createdBy: 'fable-5',
    automationState: activeWaitState(headSha),
  });
}

describe('#1371 fenced terminal projection retirement', () => {
  it('grounds the regression fixture in the read-only #1391 generation-4 observation', async () => {
    const fixture = JSON.parse(
      await readFile(new URL('./fixtures/f167-issue-1371-pr1391-generation4.json', import.meta.url), 'utf8'),
    );
    assert.equal(fixture.leaseId, '52752674-4234-4f23-97fd-8bcb25c86025');
    assert.equal(fixture.generation, 4);
    assert.equal(fixture.status, 'replaceable');
    assert.equal(fixture.terminalPredicate.headSha, HEAD_A);
    assert.equal(fixture.grounding.trackingTaskPresent, false);
  });

  it('retires the exact Queue fence and matching tracking generation idempotently', async () => {
    const lease = completedLease();
    const taskStore = new TaskStore();
    const task = await createTrackingTask(taskStore);
    const queueCustodyCoordinator = {
      retireActionSuccessorFence: mock.fn(async () => ({
        changed: true,
        messageId: 'message-1391',
        threadId: 'thread_mp3ab0r9xqxrkrc5',
        userId: 'default-user',
        entryIds: ['queue-1391'],
        targetCatIds: ['codex-sol'],
      })),
    };
    const invocationQueue = {
      listActionSuccessorFence: mock.fn(() => [
        {
          entryId: 'queue-1391',
          threadId: 'thread_mp3ab0r9xqxrkrc5',
          userId: 'default-user',
          messageIds: ['message-1391'],
        },
      ]),
      retireActionSuccessorFence: mock.fn(() => [
        {
          entryId: 'queue-1391',
          threadId: 'thread_mp3ab0r9xqxrkrc5',
          userId: 'default-user',
          messageIds: ['message-1391'],
        },
      ]),
    };
    const publishQueue = mock.fn(async () => undefined);
    const service = new ActionSuccessorProjectionRetirementService({
      queueCustodyCoordinator,
      invocationQueue,
      taskStore,
      publishQueue,
    });

    await service.retire(lease);
    await service.retire(lease);

    const retired = await taskStore.get(task.id);
    assert.equal(retired.status, 'done');
    assert.equal(retired.automationState.await, undefined);
    assert.equal(retired.automationState.ci.headSha, HEAD_A);
    assert.equal(queueCustodyCoordinator.retireActionSuccessorFence.mock.calls.length, 2);
    assert.equal(invocationQueue.retireActionSuccessorFence.mock.calls.length, 2);
    assert.deepEqual(publishQueue.mock.calls[0].arguments[0], {
      threadId: 'thread_mp3ab0r9xqxrkrc5',
      userId: 'default-user',
      receiptMessageIds: ['message-1391'],
    });
  });

  it('persists direct A2A Queue retirement before removing a carrier when the lease has no delivered-message field', async () => {
    const {
      dispatchDeliveredMessageId: _messageId,
      dispatchDeliveryState: _deliveryState,
      ...lease
    } = completedLease();
    const events = [];
    const taskStore = new TaskStore();
    const queueCustodyCoordinator = {
      retireActionSuccessorFence: mock.fn(async (messageId) => {
        events.push(`durable:${messageId}`);
        return {
          changed: true,
          messageId,
          threadId: 'thread_mp3ab0r9xqxrkrc5',
          userId: 'default-user',
          entryIds: ['queue-direct'],
          targetCatIds: ['codex-sol'],
        };
      }),
    };
    const invocationQueue = {
      listActionSuccessorFence: mock.fn(() => {
        events.push('process:list');
        return [
          {
            entryId: 'queue-direct',
            threadId: 'thread_mp3ab0r9xqxrkrc5',
            userId: 'default-user',
            messageIds: ['message-direct'],
          },
        ];
      }),
      retireActionSuccessorFence: mock.fn(() => {
        events.push('process:retire');
        return [];
      }),
    };
    const service = new ActionSuccessorProjectionRetirementService({
      queueCustodyCoordinator,
      invocationQueue,
      taskStore,
      publishQueue: async () => events.push('publish'),
    });

    await service.retire(lease);

    assert.deepEqual(events, ['process:list', 'durable:message-direct', 'process:retire', 'publish']);
  });

  it('does not retire fresh-HEAD tracking while converging the old fenced projection', async () => {
    const lease = completedLease();
    const taskStore = new TaskStore();
    const task = await createTrackingTask(taskStore, HEAD_B);
    const queueCustodyCoordinator = { retireActionSuccessorFence: mock.fn(async () => null) };
    const invocationQueue = {
      listActionSuccessorFence: mock.fn(() => []),
      retireActionSuccessorFence: mock.fn(() => []),
    };
    const publishQueue = mock.fn(async () => undefined);
    const service = new ActionSuccessorProjectionRetirementService({
      queueCustodyCoordinator,
      invocationQueue,
      taskStore,
      publishQueue,
    });

    await service.retire(lease);

    const preserved = await taskStore.get(task.id);
    assert.equal(preserved.status, 'todo');
    assert.equal(preserved.automationState.await.generation, 4);
    assert.equal(preserved.automationState.ci.headSha, HEAD_B);
  });
});
