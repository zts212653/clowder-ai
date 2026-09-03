import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { MessageStore } from '../../dist/domains/cats/services/stores/ports/MessageStore.js';
import {
  createReevalCaseTaskQueueDelivery,
  ReevalCaseTaskDispatcher,
} from '../../dist/infrastructure/harness-eval/reeval-case-task-dispatch.js';

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
  terminalPredicate: { kind: 'task_done' },
};

describe('F266 durable stable-case task carrier', () => {
  it('persists one idempotent queued message and replays delivery for crash recovery', async () => {
    const messageStore = new MessageStore();
    const deliveries = [];
    const dispatcher = new ReevalCaseTaskDispatcher({
      messageStore,
      async deliver(input) {
        deliveries.push(structuredClone(input));
        return { outcome: 'enqueued' };
      },
      now: () => 100,
    });
    const input = {
      kind: 'reevaluation',
      caseId: 'case-1',
      verdictId: 'cycle-1',
      sourceThreadId: task.threadId,
      callerCatId: 'gpt52',
      task,
      lease,
    };

    const first = await dispatcher.dispatch(input);
    const replay = await dispatcher.dispatch(input);

    assert.equal(first.messageId, replay.messageId);
    assert.equal(deliveries.length, 2);
    assert.equal(deliveries[0].message.id, first.messageId);
    assert.equal(deliveries[0].lease.leaseId, lease.leaseId);
    assert.equal(deliveries[0].message.deliveryStatus, 'queued');
    assert.deepEqual(deliveries[0].message.mentions, ['gpt52']);
    assert.match(deliveries[0].message.content, /task-reeval-1/);
    assert.match(deliveries[0].message.content, /case-1/);
  });

  it('returns a durable blocker result when the queue carrier is persisted but not accepted', async () => {
    const messageStore = new MessageStore();
    const dispatcher = new ReevalCaseTaskDispatcher({
      messageStore,
      async deliver() {
        return { outcome: 'unavailable' };
      },
      now: () => 100,
    });

    const result = await dispatcher.dispatch({
      kind: 'responsibility',
      caseId: 'case-1',
      verdictId: 'cycle-1',
      sourceThreadId: 'thread_eval_freshness',
      callerCatId: 'gpt52',
      task,
      lease,
    });

    assert.equal(result.outcome, 'blocked');
    assert.equal(result.reasonCode, 'carrier_not_enqueued');
    assert.ok(result.messageId);
  });

  it('distinguishes carrier persistence failure from delivery failure', async () => {
    const persistWarnings = [];
    const persistError = new Error('message store unavailable');
    const persistFailure = new ReevalCaseTaskDispatcher({
      messageStore: {
        async append() {
          throw persistError;
        },
      },
      async deliver() {
        throw new Error('delivery must not run when persistence fails');
      },
      log: {
        warn(context, message) {
          persistWarnings.push({ context, message });
        },
      },
      now: () => 100,
    });
    const input = {
      kind: 'reevaluation',
      caseId: 'case-1',
      verdictId: 'cycle-1',
      sourceThreadId: task.threadId,
      callerCatId: 'gpt52',
      task,
      lease,
    };

    assert.deepEqual(await persistFailure.dispatch(input), {
      outcome: 'blocked',
      reasonCode: 'carrier_persist_failed',
    });
    assert.equal(persistWarnings.length, 1);
    assert.equal(persistWarnings[0].context.err, persistError);
    assert.equal(persistWarnings[0].context.reasonCode, 'carrier_persist_failed');
    assert.match(persistWarnings[0].message, /carrier persistence failed/);

    const deliveryWarnings = [];
    const deliveryError = new Error('queue transport unavailable');
    const deliveryFailure = new ReevalCaseTaskDispatcher({
      messageStore: new MessageStore(),
      async deliver() {
        throw deliveryError;
      },
      log: {
        warn(context, message) {
          deliveryWarnings.push({ context, message });
        },
      },
      now: () => 100,
    });
    const result = await deliveryFailure.dispatch(input);

    assert.equal(result.outcome, 'blocked');
    assert.equal(result.reasonCode, 'carrier_delivery_failed');
    assert.ok(result.messageId);
    assert.equal(deliveryWarnings.length, 1);
    assert.equal(deliveryWarnings[0].context.err, deliveryError);
    assert.equal(deliveryWarnings[0].context.reasonCode, 'carrier_delivery_failed');
    assert.equal(deliveryWarnings[0].context.messageId, result.messageId);
    assert.match(deliveryWarnings[0].message, /carrier delivery failed/);
  });

  it('binds the active lease generation and dispatch identity to the queue carrier', async () => {
    const enqueues = [];
    const deliver = createReevalCaseTaskQueueDelivery(async (input) => {
      enqueues.push(structuredClone(input));
      return { accepted: true };
    });
    const messageStore = new MessageStore();
    const message = await messageStore.append({
      userId: task.userId,
      catId: 'gpt52',
      content: 'execute stable-case task',
      mentions: ['gpt52'],
      timestamp: 100,
      threadId: task.threadId,
      deliveryStatus: 'queued',
    });

    assert.deepEqual(
      await deliver({
        message,
        task,
        lease: {
          ...lease,
          terminalPredicate: { kind: 'task_done', digest: 'sha256:task-done' },
        },
        sourceThreadId: task.threadId,
        callerCatId: 'gpt52',
      }),
      { outcome: 'enqueued' },
    );
    assert.equal(enqueues.length, 1);
    assert.equal(enqueues[0].targetCatId, 'gpt52');
    assert.deepEqual(enqueues[0].actionSuccessorFence, {
      leaseId: lease.leaseId,
      generation: lease.generation,
      dispatchId: lease.dispatchId,
      terminalPredicateDigest: 'sha256:task-done',
      invocationLineageRef: `dispatch:${lease.dispatchId}`,
    });
  });
});
