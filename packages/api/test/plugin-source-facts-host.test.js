import assert from 'node:assert/strict';
import { test } from 'node:test';
import Fastify from 'fastify';
import { currentPluginCallContext } from '../dist/domains/plugin/carrier/plugin-call-context.js';
import { NativePluginActions } from '../dist/domains/plugin/declared/native-plugin-actions.js';
import { pluginNativeActionRoutes } from '../dist/routes/plugin-native-action-routes.js';
import { neutralFixture } from './helpers/neutral-host-fixture.js';

function ports(f) {
  assert.equal(typeof f.host().sourceFacts?.read, 'function', 'Missing Host sourceFacts port');
  assert.equal(typeof f.host().nativeContext?.current, 'function', 'Missing Host nativeContext port');
}
async function fixture(t, options = {}) {
  return neutralFixture(t, { capabilities: ['thread.readContent'], ...options });
}
async function source(f, overrides = {}) {
  const {
    source: presentation = {
      connector: 'neutral',
      label: 'Neutral',
      icon: 'message',
      meta: { participation: { revision: 3 } },
    },
    ...rest
  } = overrides;
  const message = f.messages.append({
    userId: f.owner,
    threadId: f.thread.id,
    from: { kind: 'plugin', instanceId: f.installed.pluginInstanceId },
    content: 'external request',
    mentions: [],
    timestamp: 1,
    extra: {
      pluginMessage: {
        instanceId: f.installed.pluginInstanceId,
        revision: 1,
        presentation: Object.hasOwn(overrides, 'source') ? overrides.source : presentation,
        provenance: { origin: { kind: 'external' } },
        elements: [],
        appendOps: [],
      },
      private: 'excluded',
    },
    ...Object.fromEntries(Object.entries(rest).filter(([key]) => key !== 'extra')),
  });
  if (Object.hasOwn(rest, 'extra')) message.extra = rest.extra;
  return message;
}
async function result(promise) {
  const r = await promise;
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().available, true);
  return r.json().result;
}

test('owner source read projects exact same-instance source without requiring mentions or exposing extra data', async (t) => {
  const f = await fixture(t);
  ports(f);
  const m = await source(f);
  const read = await result(f.httpGet('sourceFacts', 'read', { messageRef: `message:${m.id}` }));
  assert.deepEqual(read, {
    id: m.id,
    userId: f.owner,
    threadId: f.thread.id,
    catId: null,
    content: m.content,
    source: { connector: 'neutral', meta: { participation: { revision: 3 } } },
    extra: { pluginMessage: { instanceId: f.installed.pluginInstanceId } },
  });
  await assert.rejects(() => f.host().sourceFacts.read({ messageRef: `message:${m.id}` }));
  assert.notEqual((await f.httpGet('nativeContext', 'current')).statusCode, 200);
});

test('installed owner action reaches progress projection while queued body remains inaccessible', async (t) => {
  const f = await fixture(t);
  const m = await source(f, { deliveryStatus: 'queued' });
  const value = await result(f.httpGet('sourceFacts', 'readProgress', { messageRef: `message:${m.id}` }));
  assert.equal(value.id, m.id);
  assert.equal(value.userId, f.owner);
  assert.equal(value.content, undefined);
  assert.equal(value.queueCustody, undefined, 'no Queue admission must not become invented progress');
  assert.notEqual((await f.httpGet('sourceFacts', 'read', { messageRef: `message:${m.id}` })).statusCode, 200);
  await assert.rejects(() =>
    f.native(
      'sourceFacts',
      'readProgress',
      { messageRef: `message:${m.id}` },
      {
        originTriggerMessageId: m.id,
      },
    ),
  );
});

test('source read rejects foreign ownership, forged instance, missing provenance, invalid source and uncommitted content', async (t) => {
  const f = await fixture(t);
  ports(f);
  for (const overrides of [
    { userId: 'foreign' },
    { extra: {} },
    { extra: { pluginMessage: { instanceId: 'foreign', revision: 1, provenance: {}, elements: [], appendOps: [] } } },
    { deletedAt: 1 },
    { _tombstone: true },
    { deliveryStatus: 'queued' },
    { source: undefined },
  ]) {
    const m = await source(f, overrides);
    assert.notEqual((await f.httpGet('sourceFacts', 'read', { messageRef: `message:${m.id}` })).statusCode, 200);
  }
  const foreign = await f.threads.create('foreign', 'private');
  const m = await source(f, { threadId: foreign.id });
  assert.notEqual((await f.httpGet('sourceFacts', 'read', { messageRef: `message:${m.id}` })).statusCode, 200);
  assert.notEqual((await f.httpGet('sourceFacts', 'read', { messageRef: 'message:missing' })).statusCode, 200);
});

test('native source context uses exact invocation origin instead of typed-wait source or tool body', async (t) => {
  const f = await fixture(t);
  ports(f);
  const m = await source(f),
    other = await source(f, { content: 'other' });
  const caller = {
    originTriggerMessageId: m.id,
    source: { kind: 'adopted_hold', sourceMessageId: other.id, holdTaskId: 'hold' },
  };
  const value = (await f.native('nativeContext', 'current', undefined, caller)).result;
  assert.equal(value.originTriggerMessageId, m.id);
  assert.equal(value.invocationId, 'inv');
  assert.equal(value.catId, 'cat');
  assert.equal(value.source.id, m.id);
  assert.equal(Object.isFrozen(value), true);
  assert.equal(Object.isFrozen(value.source.source.meta.participation), true);
  const read = (await f.native('sourceFacts', 'read', { messageRef: `message:${m.id}` }, caller)).result;
  assert.equal(read.id, m.id);
  await assert.rejects(() => f.native('sourceFacts', 'read', { messageRef: `message:${other.id}` }, caller));
  await assert.rejects(() =>
    f.native('sourceFacts', 'read', { messageRef: `message:${m.id}`, userId: f.owner }, caller),
  );
  await assert.rejects(() => f.native('nativeContext', 'current', { originTriggerMessageId: other.id }, caller));
  await assert.rejects(() => f.native('nativeContext', 'current'));
  await assert.rejects(() => f.native('nativeContext', 'current', undefined, { ...caller, userId: 'foreign' }));
});

test('source results are withheld if source is recalled or thread becomes unavailable across async reads', async (t) => {
  const f = await fixture(t);
  ports(f);
  const m = await source(f);
  const get = f.messages.getById.bind(f.messages);
  let reads = 0;
  f.messages.getById = async (id) => {
    const value = structuredClone(await get(id));
    if (id === m.id && ++reads >= 2) value.recall = { recalledAt: 1 };
    return value;
  };
  assert.notEqual((await f.httpGet('sourceFacts', 'read', { messageRef: `message:${m.id}` })).statusCode, 200);
  assert.ok(reads >= 2);
  f.messages.getById = get;
  const threadGet = f.threads.get.bind(f.threads);
  let threadReads = 0;
  f.threads.get = async (id) => {
    const value = structuredClone(await threadGet(id));
    if (id === m.threadId && ++threadReads >= 2) value.deletedAt = 1;
    return value;
  };
  await assert.rejects(() => f.native('nativeContext', 'current', undefined, { originTriggerMessageId: m.id }));
});

test('source ports recheck read grants and invoking turn before releasing immutable source results', async (t) => {
  const f = await fixture(t);
  ports(f);
  const m = await source(f);
  const get = f.messages.getById.bind(f.messages);
  let current = true;
  f.messages.getById = async (id) => {
    const value = await get(id);
    current = false;
    return value;
  };
  await assert.rejects(() =>
    f.native('nativeContext', 'current', undefined, {
      originTriggerMessageId: m.id,
      assertCurrent: async () => {
        if (!current) throw Error('expired');
      },
    }),
  );
  f.messages.getById = async (id) => {
    const value = await get(id);
    await f.runtime.inventoryStore.transaction((tx) => {
      const grant = tx.grants.get(f.installed.pluginInstanceId);
      tx.grants.put({ ...grant, grantRevision: grant.grantRevision + 1 });
    });
    return value;
  };
  assert.notEqual((await f.httpGet('sourceFacts', 'read', { messageRef: `message:${m.id}` })).statusCode, 200);
});

test('source facts do not confer content access without the existing thread.readContent grant', async (t) => {
  const f = await fixture(t, { capabilities: [] });
  ports(f);
  const m = await source(f);
  let reads = 0;
  f.messages.getById = async () => {
    reads++;
    return m;
  };
  assert.notEqual((await f.httpGet('sourceFacts', 'read', { messageRef: `message:${m.id}` })).statusCode, 200);
  await assert.rejects(() => f.native('nativeContext', 'current', undefined, { originTriggerMessageId: m.id }));
  assert.equal(reads, 0);
});

test('native action HTTP carrier projects origin from authenticated record and rejects drift during admission', async (t) => {
  const app = Fastify();
  t.after(() => app.close());
  const record = {
    invocationId: 'inv',
    callbackToken: 'token',
    catId: 'cat',
    userId: 'owner',
    threadId: 'thread',
    originTriggerMessageId: 'exact-origin',
  };
  let drift = false;
  const admission = {
    instance: {
      pluginInstanceId: 'instance',
      packageDigest: 'digest',
      lifecycleRevision: 1,
      activationState: 'enabled',
      lifecycleState: 'installed',
      configReadiness: 'ready',
    },
    packageRecord: {
      manifest: {
        features: [{ capabilities: [], contributions: [{ type: 'mcp', id: 'native' }] }],
        contributions: [{ type: 'mcp', id: 'native', actions: [{ method: 'read' }] }],
      },
    },
    effectiveGrants: [],
  };
  const actions = new NativePluginActions(async () => {
    if (drift) record.originTriggerMessageId = 'changed';
    return admission;
  });
  actions.activate(admission, 0, async () => ({
    origin: currentPluginCallContext('instance')?.originTriggerMessageId,
  }));
  const verify = async () => ({ ok: true, record });
  await app.register(pluginNativeActionRoutes, {
    actions,
    registry: { verify, verifyLatest: verify, isStartupRecoveryComplete: () => true },
    sources: { messageStore: { getById: async () => null } },
    threadStore: { get: async () => ({ createdBy: 'owner' }) },
  });
  const request = () =>
    app.inject({
      method: 'POST',
      url: '/api/plugin-runtime/action',
      headers: {
        'x-invocation-id': 'inv',
        'x-callback-token': 'token',
        'x-clowder-plugin-action-token': actions.environment('instance', 'native').CLOWDER_PLUGIN_ACTION_TOKEN,
      },
      payload: { method: 'read', input: { originTriggerMessageId: 'forged' } },
    });
  const r = await request();
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().result.origin, 'exact-origin', 'Missing authenticated native origin projection');
  drift = true;
  assert.notEqual((await request()).statusCode, 200);
});
