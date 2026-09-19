// @ts-check

import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { InvocationQueue } from '../dist/domains/cats/services/agents/invocation/InvocationQueue.js';
import { MessageStore } from '../dist/domains/cats/services/stores/ports/MessageStore.js';
import { ConnectorInvokeTrigger } from '../dist/infrastructure/email/ConnectorInvokeTrigger.js';
import { canonicalTestMessageInput } from './helpers/message-from-fixtures.js';

function noopLog() {
  const noop = () => {};
  return /** @type {any} */ ({ info: noop, warn: noop, error: noop, debug: noop, trace: noop, fatal: noop });
}

function socketHarness() {
  const userEvents = /** @type {Array<{userId: string, event: string, payload: any}>} */ ([]);
  return {
    userEvents,
    manager: /** @type {any} */ ({
      emitToUser(userId, event, payload) {
        userEvents.push({ userId, event, payload });
      },
      broadcastAgentMessage() {},
      broadcastToRoom() {},
    }),
  };
}

describe('ConnectorInvokeTrigger canonical Queue ingress', () => {
  /** @type {InvocationQueue} */
  let queue;
  /** @type {MessageStore} */
  let messageStore;
  /** @type {ReturnType<typeof socketHarness>} */
  let sockets;
  /** @type {string[]} */
  let drains;
  /** @type {ConnectorInvokeTrigger} */
  let trigger;

  beforeEach(() => {
    queue = new InvocationQueue();
    messageStore = new MessageStore();
    sockets = socketHarness();
    drains = [];
    trigger = makeTrigger();
  });

  function makeTrigger(overrides = /** @type {any} */ ({})) {
    return new ConnectorInvokeTrigger({
      socketManager: sockets.manager,
      invocationQueue: queue,
      queueProcessor: /** @type {any} */ ({
        async requestDrain(threadId) {
          drains.push(threadId);
        },
      }),
      messageStore,
      log: noopLog(),
      ...overrides,
    });
  }

  function appendSource(idSuffix, options = /** @type {any} */ ({})) {
    return messageStore.append(
      canonicalTestMessageInput({
        threadId: options.threadId ?? 'thread-1',
        userId: options.userId ?? 'user-1',
        catId: null,
        content: `connector-${idSuffix}`,
        mentions: ['opus'],
        timestamp: Date.now(),
        source: options.source ?? { connector: 'github', label: 'GitHub' },
        ...(options.deliveryStatus ? { deliveryStatus: options.deliveryStatus } : {}),
      }),
    );
  }

  it('atomically commits one canonical Queue row before requesting a drain', async () => {
    const source = appendSource('idle');
    assert.equal(await trigger.trigger(source.threadId, 'opus', source.userId, source.content, source.id), 'enqueued');

    const entries = queue.list(source.threadId, source.userId);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].payload.messageId, source.id);
    assert.deepEqual(entries[0].from, { kind: 'external', connectorId: 'github' });
    assert.equal(entries[0].execution.ownerAuthProvenance, 'unknown');
    assert.deepEqual(entries[0].targets, ['opus']);
    assert.equal(messageStore.getById(source.id)?.deliveryStatus, 'queued');
    assert.deepEqual(drains, [source.threadId]);
    assert.ok(sockets.userEvents.some((event) => event.event === 'queue_updated'));
  });

  it('deduplicates an exact source without a second Queue carrier', async () => {
    const source = appendSource('duplicate');
    const args = /** @type {const} */ ([source.threadId, 'opus', source.userId, source.content, source.id]);
    assert.equal(await trigger.trigger(...args), 'enqueued');
    assert.equal(await trigger.trigger(...args), 'enqueued');
    assert.equal(queue.list(source.threadId, source.userId).length, 1);
    assert.deepEqual(drains, [source.threadId, source.threadId]);
  });

  it('keeps separate connector messages as separate deterministic ledger rows', async () => {
    const first = appendSource('burst-1');
    const second = appendSource('burst-2');
    const policy = { sourceCategory: /** @type {const} */ ('review'), coalesceKey: 'pr-42' };
    await trigger.trigger(first.threadId, 'opus', first.userId, first.content, first.id, undefined, policy);
    await trigger.trigger(second.threadId, 'opus', second.userId, second.content, second.id, undefined, policy);
    const entries = queue.list(first.threadId, first.userId);
    assert.equal(entries.length, 2);
    assert.deepEqual(
      entries.map((entry) => entry.payload.messageId),
      [first.id, second.id],
    );
  });

  it('preserves sender, urgency, category and Skill metadata', async () => {
    const source = appendSource('metadata', {
      source: { connector: 'github', label: 'GitHub', sender: { id: 'github-app', name: 'GitHub App' } },
    });
    await trigger.trigger(source.threadId, 'opus', source.userId, source.content, source.id, undefined, {
      priority: 'urgent',
      sourceCategory: 'ci',
      suggestedSkill: 'merge-gate',
    });
    const entry = queue.list(source.threadId, source.userId)[0];
    assert.equal(entry.priority, 'urgent');
    assert.equal(entry.sourceCategory, 'ci');
    assert.equal(entry.execution.suggestedSkill, 'merge-gate');
    assert.deepEqual(entry.from, {
      kind: 'external',
      connectorId: 'github',
      sender: { id: 'github-app', name: 'GitHub App' },
    });
  });

  it('copies the exact wait continuation carrier into the Queue ledger', async () => {
    const carrier = {
      v: 1,
      waitId: 'task-pr-7',
      outcomeId: 'wait:pr:owner/repo#7:g3:matched',
      ownerFence: { kind: 'containing_task', generation: 3 },
    };
    const source = appendSource('wait', {
      source: { connector: 'github-wait', label: 'GitHub Wait', meta: { waitContinuationCarrier: carrier } },
    });
    await trigger.trigger(source.threadId, 'opus', source.userId, source.content, source.id, undefined, {
      sourceCategory: 'review',
    });
    assert.deepEqual(queue.list(source.threadId, source.userId)[0].execution.waitContinuationCarrier, carrier);
  });

  it('freezes a verified managed-command action generation on the Queue row', async () => {
    const lease = /** @type {any} */ ({
      leaseId: 'lease-review-1',
      generation: 3,
      status: 'active',
      tenantScope: 'user-1',
      holderThreadId: 'thread-1',
      holderCatIds: ['opus'],
      dispatchId: 'dispatch-review-1',
      terminalPredicate: { digest: 'predicate-digest' },
    });
    const source = appendSource('managed', {
      source: {
        connector: 'hold-ball',
        label: '持球通知',
        meta: {
          taskId: 'task-managed',
          threadId: 'thread-1',
          catId: 'opus',
          wakeWhen: true,
          actionLeaseRef: { leaseId: lease.leaseId, generation: lease.generation },
        },
      },
    });
    const managed = makeTrigger({ actionSuccessorLeaseStore: { get: async () => lease } });
    await managed.trigger(source.threadId, 'opus', source.userId, source.content, source.id, undefined, {
      sourceCategory: 'scheduled',
      forceQueue: true,
      ownerAuthProvenance: 'strict',
    });
    assert.deepEqual(queue.list(source.threadId, source.userId)[0].execution.actionSuccessorFence, {
      leaseId: lease.leaseId,
      generation: lease.generation,
      dispatchId: lease.dispatchId,
      terminalPredicateDigest: 'predicate-digest',
      invocationLineageRef: `dispatch:${lease.dispatchId}`,
    });
  });

  it('rejects a stale managed-command action generation before Queue admission', async () => {
    const source = appendSource('stale-managed', {
      source: {
        connector: 'hold-ball',
        label: '持球通知',
        meta: {
          taskId: 'task-managed',
          threadId: 'thread-1',
          catId: 'opus',
          wakeWhen: true,
          actionLeaseRef: { leaseId: 'lease-review-1', generation: 3 },
        },
      },
    });
    const stale = makeTrigger({
      actionSuccessorLeaseStore: { get: async () => ({ leaseId: 'lease-review-1', generation: 4 }) },
    });
    await assert.rejects(
      stale.trigger(source.threadId, 'opus', source.userId, source.content, source.id),
      /generation no longer matches/,
    );
    assert.equal(queue.list(source.threadId, source.userId).length, 0);
  });

  it('fails closed when source owner or thread does not match the trigger', async () => {
    const source = appendSource('mismatch');
    await assert.rejects(
      trigger.trigger('thread-other', 'opus', source.userId, source.content, source.id),
      /does not match/,
    );
    assert.equal(queue.list('thread-other', source.userId).length, 0);
  });

  it('keeps committed Queue work when drain scheduling fails', async () => {
    const source = appendSource('drain-failure');
    const failing = makeTrigger({
      queueProcessor: {
        async requestDrain() {
          throw new Error('drain unavailable');
        },
      },
    });
    assert.equal(await failing.trigger(source.threadId, 'opus', source.userId, source.content, source.id), 'enqueued');
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(queue.list(source.threadId, source.userId).length, 1);
  });
});
