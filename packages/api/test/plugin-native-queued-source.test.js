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

const sourceId = '0000000000001000-000001-00000001';

async function fixture(generic = false) {
  const carrier = {
    version: 1,
    admissionId: 'admission',
    sourceMessageId: sourceId,
    sourcePluginRevision: 1,
    pluginInstanceId: 'instance',
    packageDigest: 'digest',
    lifecycleRevision: 1,
    grantRevision: 0,
    contributionId: 'native',
    actionMethods: ['native.read'],
    targetCatId: 'astra',
    authorityRef: 'authority',
    authorityRevision: 'r1',
  };
  const store = new MessageStore(),
    queue = new InvocationQueue();
  const source = store.append({
    reservedId: sourceId,
    userId: 'owner',
    threadId: 'thread',
    from: { kind: 'plugin', instanceId: 'instance' },
    content: 'public input',
    mentions: ['astra'],
    timestamp: 1000,
    extra: {
      pluginMessage: {
        instanceId: 'instance',
        revision: 1,
        presentation: { connector: 'fixture', label: 'Fixture', icon: 'message' },
      },
    },
  });
  const { entry } = await queue.enqueueExistingMessageDurable(store, sourceId, {
    userId: 'owner',
    threadId: 'thread',
    from: source.from,
    sourceId,
    messageId: sourceId,
    kind: 'conversation_input',
    content: source.content,
    targetCats: ['astra'],
    intent: 'execute',
    ownerAuthProvenance: 'unknown',
    autoExecute: true,
    ...(generic ? {} : { pluginPublicInvocation: carrier }),
  });
  const port = { getById: async (id) => structuredClone(store.getById(id)) };
  const bind = async () => {
    const response = store.append({
      userId: 'owner',
      threadId: 'thread',
      from: { kind: 'agent', catId: 'astra' },
      content: '',
      mentions: [],
      timestamp: 2000,
      lifecycle: {
        kind: 'response',
        orderKey: '2000:response',
        invocationId: 'child-1',
        targetId: 'astra',
        inputEntryIds: [entry.id],
        inputMessageIds: [sourceId],
        status: 'processing',
        startedAt: 2000,
      },
    });
    return store.advanceLifecycleInputDispatch(sourceId, {
      orderKey: store.getById(sourceId).lifecycle.orderKey,
      targetId: 'astra',
      phase: 'dispatched',
      statusMessageId: response.id,
      dispatchedAt: 2000,
    });
  };
  const host = createPluginSourceFactsHost({
    pluginInstanceId: 'instance',
    ownerUserId: 'owner',
    messageStore: port,
    threadStore: { get: async () => ({ id: 'thread', createdBy: 'owner', participants: ['astra'] }) },
    assertCurrent: async () => {},
  });
  const native = (overrides = {}) =>
    withPluginCallContext(
      'instance',
      {
        userId: 'owner',
        threadId: 'thread',
        catId: 'astra',
        invocationId: 'child-1',
        originTriggerMessageId: sourceId,
        assertCurrent: async () => {},
        assertInvocationCurrent: async () => {},
        ...overrides,
      },
      () => host.nativeContext.current(),
    );
  return { entry, store, port, bind, host, native };
}

test('native context reads the queued origin bound to its authenticated running child', async () => {
  const f = await fixture();
  assert.equal((await f.bind()).kind, 'applied');
  const before = structuredClone(f.store.getById(sourceId));
  const value = await f.native();
  assert.equal(value.source.id, sourceId);
  assert.equal(value.invocationId, 'child-1');
  assert.equal(value.source.content, 'public input');
  assert.equal(value.source.queueCustody, undefined);
  assert.deepEqual(f.store.getById(sourceId), before);
});

test('queued source remains inaccessible without an authenticated child', async () => {
  const f = await fixture();
  await assert.rejects(() => f.host.sourceFacts.read({ messageRef: `message:${sourceId}` }));
  await assert.rejects(() => f.native());
  assert.equal((await f.bind()).kind, 'applied');
  await assert.rejects(() =>
    withPluginOwnerRequest(
      {
        pluginId: 'plugin',
        contributionId: 'owner',
        userId: 'owner',
        operation: 'read',
        signal: new AbortController().signal,
      },
      () =>
        withPluginOwnerWebhook(
          'plugin',
          'owner',
          'instance',
          false,
          () => {},
          () => f.host.sourceFacts.read({ messageRef: `message:${sourceId}` }),
        ),
    ),
  );
});

test('queued source never substitutes another child, cat or origin', async () => {
  const f = await fixture();
  assert.equal((await f.bind()).kind, 'applied');
  for (const override of [
    { invocationId: 'foreign' },
    { catId: 'foreign' },
    { originTriggerMessageId: 'foreign' },
    { assertInvocationCurrent: undefined },
  ]) {
    await assert.rejects(() => f.native(override));
  }
});

test('queued source rejects terminal or changed custody while reading', async () => {
  for (const change of [
    (message) => {
      if (message.lifecycle?.kind === 'response') message.lifecycle.status = 'completed';
    },
    (message) => {
      if (message.lifecycle?.kind === 'response') message.lifecycle.invocationId = 'foreign';
    },
    (message) => {
      if (message.lifecycle?.kind === 'input') message.lifecycle.dispatchRefs = [];
    },
    (message) => {
      if (message.extra?.pluginMessage) message.extra.pluginMessage.revision++;
    },
    (message) => {
      message.recall = { recalledAt: 1 };
    },
  ]) {
    const f = await fixture();
    assert.equal((await f.bind()).kind, 'applied');
    const get = f.port.getById;
    let reads = 0;
    f.port.getById = async (id) => {
      const m = await get(id);
      if (++reads >= 2) change(m);
      return m;
    };
    await assert.rejects(() => f.native());
    assert.ok(reads >= 2, 'the first read must reach the valid queued source');
  }
});

test('ordinary send wake queued source is readable by its exact awakened native child without a public carrier', async () => {
  const f = await fixture(true);
  await f.bind();
  const before = structuredClone(f.store.getById(sourceId));
  assert.equal(f.entry.execution.pluginPublicInvocation, undefined);
  const value = await f.native();
  assert.equal(value.source.id, sourceId);
  assert.equal(value.invocationId, 'child-1');
  assert.deepEqual(f.store.getById(sourceId), before);
});

test('ordinary queued wake still rejects unbound, foreign and retired callers', async () => {
  const f = await fixture(true);
  await assert.rejects(() => f.native());
  await f.bind();
  assert.equal((await f.native()).source.id, sourceId);
  for (const override of [
    { invocationId: 'other' },
    { catId: 'other' },
    { userId: 'other' },
    { originTriggerMessageId: 'other' },
    { assertInvocationCurrent: undefined },
  ]) {
    await assert.rejects(() => f.native(override));
  }
  const get = f.port.getById;
  f.port.getById = async (id) => {
    const m = await get(id);
    if (m.lifecycle?.kind === 'response') m.lifecycle.status = 'completed';
    return m;
  };
  await assert.rejects(() => f.native());
});

test('ordinary queued wake rejects custody replacement or revocation across source reads', async () => {
  for (const change of [
    (m) => {
      if (m.lifecycle?.kind === 'response') m.lifecycle.inputEntryIds = ['replacement'];
    },
    (m) => {
      if (m.lifecycle?.kind === 'response') m.lifecycle.invocationId = 'replacement';
    },
    (m) => {
      if (m.extra?.pluginMessage) m.extra.pluginMessage.instanceId = 'other';
    },
    (m) => {
      m.recall = { recalledAt: 1 };
    },
  ]) {
    const f = await fixture(true);
    await f.bind();
    assert.equal((await f.native()).source.id, sourceId);
    const get = f.port.getById;
    let reads = 0;
    f.port.getById = async (id) => {
      const m = await get(id);
      if (++reads >= 2) change(m);
      return m;
    };
    await assert.rejects(() => f.native());
    assert.ok(reads >= 2);
  }
});
