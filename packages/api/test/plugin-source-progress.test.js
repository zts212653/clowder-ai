import assert from 'node:assert/strict';
import { test } from 'node:test';
import { InvocationQueue } from '../dist/domains/cats/services/agents/invocation/InvocationQueue.js';
import { MessageStore } from '../dist/domains/cats/services/stores/ports/MessageStore.js';
import { withPluginCallContext } from '../dist/domains/plugin/carrier/plugin-call-context.js';
import {
  withPluginOwnerRequest,
  withPluginOwnerWebhook,
} from '../dist/domains/plugin/carrier/plugin-owner-request-context.js';
import { createPluginSourceFactsHost } from '../dist/domains/plugin/host-surface/plugin-source-facts-host.js';

async function fixture() {
  const store = new MessageStore(),
    queue = new InvocationQueue();
  const message = store.append({
    userId: 'owner',
    threadId: 'thread',
    from: { kind: 'plugin', instanceId: 'instance' },
    content: 'secret queued body',
    mentions: ['cat'],
    timestamp: 1000,
    extra: {
      pluginMessage: {
        instanceId: 'instance',
        revision: 1,
        presentation: {
          connector: 'neutral',
          label: 'Neutral',
          icon: 'message',
          meta: { participation: { eventId: 'event' } },
        },
      },
      secret: 'private',
    },
  });
  const admission = await queue.enqueueExistingMessageDurable(store, message.id, {
    userId: 'owner',
    threadId: 'thread',
    from: message.from,
    sourceId: message.id,
    messageId: message.id,
    kind: 'conversation_input',
    content: message.content,
    targetCats: ['cat'],
    intent: 'execute',
    ownerAuthProvenance: 'unknown',
    autoExecute: true,
  });
  const messages = { getById: async (id) => structuredClone(store.getById(id)) };
  const threads = { get: async () => ({ id: 'thread', createdBy: 'owner' }) };
  const deps = {
    pluginInstanceId: 'instance',
    ownerUserId: 'owner',
    messageStore: messages,
    threadStore: threads,
    queue,
    assertCurrent: async (caps) => assert.deepEqual(caps, ['thread.readContent']),
  };
  const host = createPluginSourceFactsHost(deps);
  const owner = (operation, userId = 'owner') =>
    withPluginOwnerRequest(
      { pluginId: 'neutral', contributionId: 'owner', userId, operation: 'read', signal: new AbortController().signal },
      () => withPluginOwnerWebhook('neutral', 'owner', 'instance', false, () => {}, operation),
    );
  const read = () => owner(() => host.sourceFacts.readProgress({ messageRef: `message:${message.id}` }));
  async function respond(status) {
    const response = store.append({
      userId: 'owner',
      threadId: 'thread',
      from: { kind: 'agent', catId: 'cat' },
      content: '',
      mentions: [],
      timestamp: 2000,
      lifecycle: {
        kind: 'response',
        orderKey: '2000:response',
        invocationId: 'child',
        targetId: 'cat',
        inputEntryIds: [admission.entry.id],
        inputMessageIds: [message.id],
        status: 'processing',
        startedAt: 2000,
      },
    });
    const source = store.getById(message.id);
    assert.equal(
      store.advanceLifecycleInputDispatch(message.id, {
        orderKey: source.lifecycle.orderKey,
        targetId: 'cat',
        phase: 'dispatched',
        statusMessageId: response.id,
        dispatchedAt: 2000,
      }).kind,
      'applied',
    );
    await queue.retireClaimedLifecycleTarget('thread', admission.entry.id, 'cat');
    if (status !== 'processing') {
      assert.equal(
        store.commitLifecycleResponseTerminal(response.id, {
          invocationId: 'child',
          status,
          completedAt: 3000,
          content: '',
          mentions: [],
        }).kind,
        'applied',
      );
      assert.equal(
        store.advanceLifecycleInputDispatch(message.id, {
          orderKey: source.lifecycle.orderKey,
          targetId: 'cat',
          phase: 'settled',
          statusMessageId: response.id,
          dispatchedAt: 2000,
        }).kind,
        'applied',
      );
    }
    return response;
  }
  return {
    store,
    queue,
    message: store.getById(message.id),
    messages,
    threads,
    deps,
    host,
    owner,
    read,
    respond,
    entry: admission.entry,
  };
}
test('owner reads progress without queued body or native authority', async () => {
  const f = await fixture();
  const value = await f.read();
  assert.equal(value.content, undefined);
  assert.deepEqual(value.queueCustody.allTargetCats, ['cat']);
  assert.equal(value.queueCustody.status, 'queued');
  assert.ok(Object.isFrozen(value.queueCustody.allTargetCats));
  await assert.rejects(() => f.owner(() => f.host.sourceFacts.read({ messageRef: `message:${f.message.id}` })));
  await assert.rejects(() => f.owner(() => f.host.nativeContext.current()));
});
for (const status of ['processing', 'completed', 'failed', 'canceled', 'interrupted'])
  test(`progress reads ${status} from main History after Queue retirement`, async () => {
    const f = await fixture();
    await f.respond(status);
    assert.equal(await f.queue.getDurableEntry('thread', f.entry.id), null);
    const value = await f.read();
    assert.equal(value.content, undefined);
    assert.equal(value.queueCustody.status, status === 'processing' ? 'processing' : 'terminal');
    assert.deepEqual(value.queueCustody.handledByCatIds, status === 'completed' ? ['cat'] : []);
    assert.deepEqual(
      value.queueCustody.failedByCatIds,
      ['failed', 'canceled', 'interrupted'].includes(status) ? ['cat'] : [],
    );
    if (status === 'completed') assert.deepEqual(value.queueCustody.targetOutcomeByCatId, { cat: { handledAt: 3000 } });
    assert.deepEqual(value.queueCustody.seenByCatIds, [], 'starting a provider does not manufacture a read receipt');
  });
test('progress rejects a foreign durable Queue owner', async () => {
  const f = await fixture();
  const row = structuredClone(f.entry);
  row.owner = { kind: 'user', userId: 'foreign' };
  f.queue.getDurableEntry = async () => row;
  await assert.rejects(f.read);
});
test('progress requires current owner, grant, source, thread and queue owner; native context is insufficient', async () => {
  const f = await fixture();
  assert.equal(typeof f.host.sourceFacts.readProgress, 'function');
  await assert.rejects(() => f.host.sourceFacts.readProgress({ messageRef: `message:${f.message.id}` }));
  await assert.rejects(() =>
    f.owner(() => f.host.sourceFacts.readProgress({ messageRef: `message:${f.message.id}` }), 'foreign'),
  );
  await assert.rejects(() =>
    withPluginCallContext(
      'instance',
      {
        userId: 'owner',
        threadId: 'thread',
        catId: 'cat',
        invocationId: 'inv',
        originTriggerMessageId: f.message.id,
        assertCurrent: async () => {},
        assertInvocationCurrent: async () => {},
      },
      () => f.host.sourceFacts.readProgress({ messageRef: `message:${f.message.id}` }),
    ),
  );
  const get = f.messages.getById;
  for (const change of [
    (m) => {
      m.userId = 'foreign';
    },
    (m) => {
      m.extra.pluginMessage.instanceId = 'foreign';
    },
    (m) => {
      m.recall = { recalledAt: 1 };
    },
  ]) {
    f.messages.getById = async (id) => {
      const m = await get(id);
      change(m);
      return m;
    };
    await assert.rejects(f.read);
  }
  f.messages.getById = get;
  f.threads.get = async () => ({ id: 'thread', createdBy: 'foreign' });
  await assert.rejects(f.read);
});

test('progress is withheld on revision, lifecycle, grant or thread drift across asynchronous reads', async () => {
  for (const change of [
    (m) => {
      m.lifecycle.orderKey = 'replacement';
    },
    (m) => {
      m.extra.pluginMessage.revision++;
    },
    (m) => {
      m.lifecycle.dispatchRefs = [
        { targetId: 'cat', phase: 'dispatched', statusMessageId: 'missing', dispatchedAt: 2000 },
      ];
    },
    (m) => {
      m.extra.pluginMessage.presentation.meta.participation.eventId = 'other';
    },
  ]) {
    const f = await fixture();
    let reads = 0;
    const get = f.messages.getById;
    f.messages.getById = async (id) => {
      const m = await get(id);
      if (++reads >= 2) change(m);
      return m;
    };
    await assert.rejects(f.read);
    assert.ok(reads >= 2);
  }
  const f = await fixture();
  const get = f.messages.getById;
  f.messages.getById = async (id) => {
    const m = await get(id);
    f.deps.assertCurrent = async () => {
      throw Error('revoked');
    };
    return m;
  };
  await assert.rejects(f.read, /revoked/);
});
