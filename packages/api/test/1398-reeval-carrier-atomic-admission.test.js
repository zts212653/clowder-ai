import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { InvocationQueue } from '../dist/domains/cats/services/agents/invocation/InvocationQueue.js';
import { MessageStore } from '../dist/domains/cats/services/stores/ports/MessageStore.js';
import {
  createReevalCaseTaskQueueAdmission,
  ReevalCaseTaskDispatcher,
} from '../dist/infrastructure/harness-eval/reeval-case-task-dispatch.js';
import { appendA2ASourceWithLedgerAdmission, planA2AFanoutAdmission } from '../dist/routes/callback-a2a-trigger.js';

const task = {
  id: 'task-reeval-1',
  threadId: 'thread_eval_freshness',
  title: 'Re-evaluate freshness closure',
  why: 'F266 nextEvalAt reached',
  createdBy: 'gpt52',
  kind: 'work',
  ownerCatId: 'gpt52',
  status: 'doing',
  userId: 'user-1',
  createdAt: 1,
  updatedAt: 1,
};

const lease = {
  leaseId: 'lease-reeval-1',
  dispatchId: 'f266:case-1:cycle-1:reeval',
  generation: 1,
  status: 'active',
  subjectRef: `subject:task:${task.id}`,
  actionFamily: 'implement',
  successorSlot: 'implementer',
  holderCatIds: ['gpt52'],
  holderThreadId: task.threadId,
  tenantScope: task.userId,
  terminalPredicate: { kind: 'task_done', digest: 'sha256:task-done' },
};

const dispatchInput = {
  kind: 'reevaluation',
  caseId: 'case-1',
  verdictId: 'cycle-1',
  sourceThreadId: task.threadId,
  callerCatId: 'gpt52',
  task,
  lease,
};

const CARRIER_KEY = `f266-task-carrier:${task.id}:${lease.generation}`;

function silentLog() {
  const warnings = [];
  return { warnings, log: { warn: (context, message) => warnings.push({ context, message }) } };
}

/** The production admission half: plan the fan-out, then commit Message + Queue row together. */
function productionAdmit(messageStore, invocationQueue) {
  return createReevalCaseTaskQueueAdmission(async (request) => {
    const plan = planA2AFanoutAdmission(
      { invocationQueue },
      {
        targetCats: [request.targetCatId],
        content: request.message.content,
        userId: request.userId,
        ownerAuthProvenance: 'unknown',
        threadId: request.threadId,
        createdAt: request.message.timestamp,
        callerCatId: request.callerCatId,
        actionSuccessorFence: request.actionSuccessorFence,
      },
    );
    if (!plan.acceptedTargetCats.includes(request.targetCatId)) return { outcome: 'not_admitted' };
    const admission = await appendA2ASourceWithLedgerAdmission({ messageStore, invocationQueue }, request.message, {
      plan,
      ownerAuthProvenance: 'unknown',
      actionSuccessorFence: request.actionSuccessorFence,
    });
    return { outcome: 'admitted', messageId: admission.message.id };
  });
}

describe('F266 stable-case carrier is admitted atomically (F117 Phase I #5)', () => {
  it('commits the carrier Message and its Queue row under one key, and replays as one', async () => {
    const messageStore = new MessageStore();
    const invocationQueue = new InvocationQueue();
    const dispatcher = new ReevalCaseTaskDispatcher({
      admit: productionAdmit(messageStore, invocationQueue),
      log: silentLog().log,
      now: () => 100,
    });

    const first = await dispatcher.dispatch(dispatchInput);
    assert.equal(first.outcome, 'enqueued');

    // Both halves exist, and the Queue row is bound to the exact carrier message.
    const stored = await messageStore.getByIdempotencyKey(task.userId, task.threadId, CARRIER_KEY);
    assert.ok(stored, 'the carrier message must be persisted');
    assert.equal(stored.id, first.messageId);
    const rows = (await invocationQueue.getDurableEntriesForMessages(task.threadId, [first.messageId])).get(
      first.messageId,
    );
    assert.equal(rows?.length, 1, 'exactly one durable Queue row must accompany the carrier');
    assert.deepEqual(rows[0].targets, ['gpt52']);
    assert.equal(rows[0].execution.actionSuccessorFence.leaseId, lease.leaseId);
    assert.equal(rows[0].execution.actionSuccessorFence.generation, lease.generation);

    // Replaying the same lease generation is the same admission, not a second dispatch. Before the
    // migration the two halves used different keys (`f266-task-carrier:…` vs `action:…`), so they
    // could disagree about whether this generation had already been dispatched.
    const replay = await dispatcher.dispatch(dispatchInput);
    assert.equal(replay.outcome, 'enqueued');
    assert.equal(replay.messageId, first.messageId);
    const replayRows = (await invocationQueue.getDurableEntriesForMessages(task.threadId, [first.messageId])).get(
      first.messageId,
    );
    assert.equal(replayRows?.length, 1, 'replay must not add a second Queue row');
  });

  it('leaves nothing persisted when the carrier is not admitted', async () => {
    const messageStore = new MessageStore();
    const { warnings, log } = silentLog();
    const dispatcher = new ReevalCaseTaskDispatcher({
      admit: async () => ({ outcome: 'not_admitted' }),
      log,
      now: () => 100,
    });

    const result = await dispatcher.dispatch(dispatchInput);

    // Old behaviour: a queued Message was already persisted, and the blocker carried its id as
    // `carrier_not_enqueued` — a half-commit with a name. Atomic admission has no such state.
    assert.deepEqual(result, { outcome: 'blocked', reasonCode: 'carrier_persist_failed' });
    assert.equal(result.messageId, undefined);
    assert.ok(
      !(await messageStore.getByIdempotencyKey(task.userId, task.threadId, CARRIER_KEY)),
      'a refused carrier must leave no message behind',
    );
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0].context.reasonCode, 'carrier_persist_failed');
    assert.equal(warnings[0].context.leaseGeneration, lease.generation);
  });

  it('reports one retryable blocker when admission throws, and still persists nothing', async () => {
    const messageStore = new MessageStore();
    const admissionError = new Error('queue ledger unavailable');
    const { warnings, log } = silentLog();
    const dispatcher = new ReevalCaseTaskDispatcher({
      admit: async () => {
        throw admissionError;
      },
      log,
      now: () => 100,
    });

    assert.deepEqual(await dispatcher.dispatch(dispatchInput), {
      outcome: 'blocked',
      reasonCode: 'carrier_persist_failed',
    });
    assert.ok(
      !(await messageStore.getByIdempotencyKey(task.userId, task.threadId, CARRIER_KEY)),
      'a failed admission must leave no message behind',
    );
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0].context.err, admissionError);
  });

  it('hands admission an unpersisted envelope carrying the active lease fence', async () => {
    const requests = [];
    const dispatcher = new ReevalCaseTaskDispatcher({
      admit: createReevalCaseTaskQueueAdmission(async (request) => {
        requests.push(request);
        return { outcome: 'admitted', messageId: 'message-1' };
      }),
      log: silentLog().log,
      now: () => 100,
    });

    assert.deepEqual(await dispatcher.dispatch(dispatchInput), { outcome: 'enqueued', messageId: 'message-1' });
    assert.equal(requests.length, 1);
    const request = requests[0];
    assert.equal(request.targetCatId, 'gpt52');
    assert.equal(request.threadId, task.threadId);
    assert.equal(request.userId, task.userId);
    assert.deepEqual(request.actionSuccessorFence, {
      leaseId: lease.leaseId,
      generation: lease.generation,
      dispatchId: lease.dispatchId,
      terminalPredicateDigest: 'sha256:task-done',
      invocationLineageRef: `dispatch:${lease.dispatchId}`,
    });
    // The envelope is still an input, not a stored message: the producer never persisted it.
    assert.equal(request.message.id, undefined);
    assert.equal(request.message.idempotencyKey, CARRIER_KEY);
    assert.equal(request.message.deliveryStatus, 'queued');
    assert.deepEqual(request.message.mentions, ['gpt52']);
    assert.match(request.message.content, /task-reeval-1/);
    assert.match(request.message.content, /case-1/);
  });
});
