// @ts-check

import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { InvocationQueue } from '../dist/domains/cats/services/agents/invocation/InvocationQueue.js';
import { MessageStore } from '../dist/domains/cats/services/stores/ports/MessageStore.js';
import { ConnectorInvokeTrigger } from '../dist/infrastructure/email/ConnectorInvokeTrigger.js';
import { canonicalTestMessageInput } from './helpers/message-from-fixtures.js';

function noopLog() {
  const noop = () => {};
  return /** @type {any} */ ({
    info: noop,
    warn: noop,
    error: noop,
    debug: noop,
    trace: noop,
    fatal: noop,
    child: () => noopLog(),
  });
}

function socketHarness() {
  const userEvents = /** @type {Array<{userId: string, event: string, payload: any}>} */ ([]);
  const broadcasts = /** @type {Array<{message: any, threadId: string}>} */ ([]);
  return {
    userEvents,
    broadcasts,
    manager: /** @type {any} */ ({
      emitToUser(userId, event, payload) {
        userEvents.push({ userId, event, payload });
      },
      broadcastAgentMessage(message, threadId) {
        broadcasts.push({ message, threadId });
      },
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
  /** @type {Map<string, any>} */
  let waitTasks;

  beforeEach(() => {
    queue = new InvocationQueue();
    messageStore = new MessageStore();
    sockets = socketHarness();
    drains = [];
    waitTasks = new Map();
    trigger = new ConnectorInvokeTrigger({
      socketManager: sockets.manager,
      invocationQueue: queue,
      queueProcessor: /** @type {any} */ ({
        async requestDrain(threadId) {
          drains.push(threadId);
        },
      }),
      messageStore,
      waitTaskStore: { get: async (taskId) => waitTasks.get(taskId) ?? null },
      log: noopLog(),
    });
  });

  function appendSource(
    idSuffix,
    options = /** @type {{threadId?: string, userId?: string, deliveryStatus?: 'queued', source?: any}} */ ({}),
  ) {
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

  it('atomically commits strict Queue ledger ownership before requesting a drain', async () => {
    const source = appendSource('idle');

    const outcome = await trigger.trigger(
      source.threadId,
      /** @type {any} */ ('opus'),
      source.userId,
      source.content,
      source.id,
    );

    assert.equal(outcome, 'enqueued');
    const entries = queue.list(source.threadId, source.userId);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].payload.messageId, source.id);
    assert.deepEqual(entries[0].from, { kind: 'external', connectorId: 'github' });
    assert.equal(entries[0].source, undefined);
    assert.equal(entries[0].execution.ownerAuthProvenance, 'strict');
    assert.equal(entries[0].execution.autoExecute, true);
    assert.deepEqual(entries[0].targets, ['opus']);

    const stored = messageStore.getById(source.id);
    assert.equal(stored?.deliveryStatus, 'queued');
    assert.equal(stored?.queueCustody, undefined);
    assert.deepEqual(drains, [source.threadId]);
    assert.equal(
      sockets.userEvents.some((event) => event.event === 'queue_updated'),
      true,
    );
  });

  it('uses the same path for a source that was already appended as queued', async () => {
    const source = appendSource('prequeued', { deliveryStatus: 'queued' });

    await trigger.trigger(source.threadId, /** @type {any} */ ('opus'), source.userId, source.content, source.id);

    const entry = queue.list(source.threadId, source.userId)[0];
    assert.ok(entry);
    assert.equal(messageStore.getById(source.id)?.deliveryStatus, 'queued');
    assert.deepEqual(drains, [source.threadId]);
  });

  it('deduplicates an exact source without creating a direct execution or second carrier', async () => {
    const source = appendSource('duplicate');
    const args = /** @type {const} */ ([
      source.threadId,
      /** @type {any} */ ('opus'),
      source.userId,
      source.content,
      source.id,
    ]);

    assert.equal(await trigger.trigger(...args), 'enqueued');
    assert.equal(await trigger.trigger(...args), 'enqueued');

    assert.equal(queue.list(source.threadId, source.userId).length, 1);
    assert.deepEqual(drains, [source.threadId, source.threadId]);
  });

  it('keeps connector burst messages as independent deterministic ledger rows', async () => {
    const first = appendSource('coalesce-1');
    const second = appendSource('coalesce-2');
    const policy = { sourceCategory: /** @type {const} */ ('review'), coalesceKey: 'pr-42' };

    await trigger.trigger(
      first.threadId,
      /** @type {any} */ ('opus'),
      first.userId,
      first.content,
      first.id,
      undefined,
      policy,
    );
    await trigger.trigger(
      second.threadId,
      /** @type {any} */ ('opus'),
      second.userId,
      second.content,
      second.id,
      undefined,
      policy,
    );

    const entries = queue.list(first.threadId, first.userId);
    assert.equal(entries.length, 2);
    assert.equal(entries[0].payload.messageId, first.id);
    assert.equal(entries[1].payload.messageId, second.id);
    assert.equal(
      entries.some((entry) => 'mergedMessageIds' in entry.payload),
      false,
    );
    assert.equal(messageStore.getById(first.id)?.deliveryStatus, 'queued');
    assert.equal(messageStore.getById(second.id)?.deliveryStatus, 'queued');
  });

  it('preserves the source MessageFrom and scheduling metadata on the Queue carrier', async () => {
    const source = appendSource('metadata', {
      source: {
        connector: 'github',
        label: 'GitHub',
        sender: { id: 'github-app', name: 'GitHub App' },
      },
    });

    await trigger.trigger(
      source.threadId,
      /** @type {any} */ ('opus'),
      source.userId,
      source.content,
      source.id,
      undefined,
      {
        priority: 'urgent',
        sourceCategory: 'ci',
        suggestedSkill: 'merge-gate',
      },
    );

    const entry = queue.list(source.threadId, source.userId)[0];
    assert.equal(entry.priority, 'urgent');
    assert.equal(entry.sourceCategory, 'ci');
    assert.equal(entry.execution.suggestedSkill, 'merge-gate');
    assert.deepEqual(entry.from, {
      kind: 'external',
      connectorId: 'github',
      sender: { id: 'github-app', name: 'GitHub App' },
    });
    assert.equal(entry.senderMeta, undefined);
  });

  it('copies the exact wait continuation carrier into the Queue ledger', async () => {
    const carrier = {
      v: 1,
      waitId: 'task-pr-7',
      outcomeId: 'wait:pr:owner/repo#7:g3:matched',
      ownerFence: { kind: 'containing_task', generation: 3 },
    };
    const source = appendSource('wait', {
      source: {
        connector: 'github-wait',
        label: 'GitHub Wait',
        meta: { waitContinuationCarrier: carrier },
      },
    });
    waitTasks.set(carrier.waitId, {
      id: carrier.waitId,
      kind: 'pr_tracking',
      threadId: source.threadId,
      userId: source.userId,
      ownerCatId: 'opus',
      automationState: {
        waitOutcome: {
          v: 1,
          outcomeId: carrier.outcomeId,
          generation: 3,
          subjectRef: 'pr:owner/repo#7',
          ownerFence: carrier.ownerFence,
          reason: 'matched',
          at: 3,
          delivery: 'pending',
          actor: { kind: 'system' },
        },
      },
    });

    await trigger.trigger(
      source.threadId,
      /** @type {any} */ ('opus'),
      source.userId,
      source.content,
      source.id,
      undefined,
      { sourceCategory: 'review' },
    );

    assert.deepEqual(queue.list(source.threadId, source.userId)[0].execution.waitContinuationCarrier, carrier);
  });

  it('rejects a replayed github-wait source after its exact outcome was delivered', async () => {
    const carrier = {
      v: 1,
      waitId: 'task-pr-stale',
      outcomeId: 'wait:pr:owner/repo#7:g4:matched',
      ownerFence: { kind: 'containing_task', generation: 4 },
    };
    const source = appendSource('stale-wait', {
      source: { connector: 'github-wait', label: 'GitHub Wait', meta: { waitContinuationCarrier: carrier } },
    });
    waitTasks.set(carrier.waitId, {
      id: carrier.waitId,
      kind: 'pr_tracking',
      threadId: source.threadId,
      userId: source.userId,
      ownerCatId: 'opus',
      automationState: {
        waitOutcome: {
          v: 1,
          outcomeId: carrier.outcomeId,
          generation: 4,
          subjectRef: 'pr:owner/repo#7',
          ownerFence: carrier.ownerFence,
          reason: 'matched',
          at: 4,
          delivery: 'delivered',
          actor: { kind: 'system' },
        },
      },
    });

    await assert.rejects(
      trigger.trigger(source.threadId, /** @type {any} */ ('opus'), source.userId, source.content, source.id),
      /continuation is stale/,
    );
    assert.equal(queue.list(source.threadId, source.userId).length, 0);
    assert.deepEqual(drains, []);
  });

  it('rejects a github-wait carrier from an obsolete task generation', async () => {
    const carrier = {
      v: 1,
      waitId: 'task-pr-regenerated',
      outcomeId: 'wait:pr:owner/repo#7:g4:matched',
      ownerFence: { kind: 'containing_task', generation: 4 },
    };
    const source = appendSource('old-generation', {
      source: { connector: 'github-wait', label: 'GitHub Wait', meta: { waitContinuationCarrier: carrier } },
    });
    waitTasks.set(carrier.waitId, {
      id: carrier.waitId,
      kind: 'pr_tracking',
      threadId: source.threadId,
      userId: source.userId,
      ownerCatId: 'opus',
      automationState: {
        waitOutcome: {
          v: 1,
          outcomeId: 'wait:pr:owner/repo#7:g5:matched',
          generation: 5,
          subjectRef: 'pr:owner/repo#7',
          ownerFence: { kind: 'containing_task', generation: 5 },
          reason: 'matched',
          at: 5,
          delivery: 'pending',
          actor: { kind: 'system' },
        },
      },
    });

    await assert.rejects(
      trigger.trigger(source.threadId, /** @type {any} */ ('opus'), source.userId, source.content, source.id),
      /continuation is stale/,
    );
    assert.equal(queue.list(source.threadId, source.userId).length, 0);
  });

  it('fails closed when the source owner or thread does not match the trigger', async () => {
    const source = appendSource('mismatch');

    await assert.rejects(
      trigger.trigger('thread-other', /** @type {any} */ ('opus'), source.userId, source.content, source.id),
      /owner\/thread mismatch/,
    );
    assert.equal(queue.list('thread-other', source.userId).length, 0);
    assert.deepEqual(drains, []);
  });

  it('keeps committed Queue ledger work when drain scheduling fails', async () => {
    const source = appendSource('drain-failure');
    const failing = new ConnectorInvokeTrigger({
      socketManager: sockets.manager,
      invocationQueue: queue,
      queueProcessor: /** @type {any} */ ({
        async requestDrain() {
          throw new Error('drain unavailable');
        },
      }),
      messageStore,
      log: noopLog(),
    });

    await assert.rejects(
      failing.trigger(source.threadId, /** @type {any} */ ('opus'), source.userId, source.content, source.id),
      /drain unavailable/,
    );

    const entry = queue.list(source.threadId, source.userId)[0];
    assert.ok(entry);
    assert.equal(messageStore.getById(source.id)?.deliveryStatus, 'queued');
  });
});
