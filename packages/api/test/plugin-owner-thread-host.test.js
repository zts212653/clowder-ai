import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PluginOwnerOperationExpiredError } from '../dist/domains/plugin/carrier/plugin-owner-operation-context.js';
import { neutralFixture } from './helpers/neutral-host-fixture.js';

const capabilities = ['thread.listMetadata', 'thread.write'];
const cats = {
  getAllCatIds: () => ['cat', 'peer'],
  getCatDisplayName: (id) => id,
  getCatAliases: () => [],
  isCatAvailable: () => true,
  getRegisteredServices: () =>
    new Map([
      ['cat', {}],
      ['peer', {}],
    ]),
};
async function fixture(t, options = {}) {
  return neutralFixture(t, { capabilities, threadProjections: { cats }, ...options });
}
function requirePort(f) {
  for (const name of ['get', 'create', 'addParticipants']) {
    assert.equal(typeof f.host().ownerThreads?.[name], 'function', `Missing Host ownerThreads.${name}`);
  }
}
async function result(response) {
  const r = await response;
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().available, true, 'Host owner thread port is missing');
  return r.json().result;
}

test('authenticated owner forwarding exposes strict thread projection, create and participant updates', async (t) => {
  const f = await fixture(t);
  const current = await result(f.httpGet('ownerThreads', 'get', f.thread.id));
  assert.deepEqual(current, { id: f.thread.id, createdBy: f.owner, participants: [] });
  const created = await result(f.http('ownerThreads', 'create', { title: 'Owner work' }));
  assert.equal(created.createdBy, f.owner);
  assert.deepEqual(created.participants, []);
  assert.equal((await f.threads.get(created.id)).title, 'Owner work');
  const updated = await result(
    f.http('ownerThreads', 'addParticipants', { threadId: created.id, catIds: ['cat', 'peer'] }),
  );
  assert.deepEqual(updated, { id: created.id, createdBy: f.owner, participants: ['cat', 'peer'] });
  await result(f.http('ownerThreads', 'addParticipants', { threadId: created.id, catIds: ['cat'] }));
  assert.deepEqual((await f.threads.get(created.id)).participants, ['cat', 'peer']);
  assert.deepEqual(current.participants, [], 'returned snapshots do not alias store participants');
});

test('plugin ownership cannot substitute for strict authenticated owner ownership', async (t) => {
  const f = await fixture(t);
  requirePort(f);
  const foreign = await f.threads.create('another-owner', 'private');
  await f.threads.updatePluginOwnership(foreign.id, {
    v: 1,
    pluginInstanceId: f.installed.pluginInstanceId,
  });
  assert.equal(await result(f.httpGet('ownerThreads', 'get', foreign.id)), null);
  const denied = await f.http('ownerThreads', 'addParticipants', { threadId: foreign.id, catIds: ['cat'] });
  assert.notEqual(denied.statusCode, 200, denied.body);
  assert.deepEqual((await f.threads.get(foreign.id)).participants, []);
  await f.threads.softDelete(f.thread.id);
  assert.equal(await result(f.httpGet('ownerThreads', 'get', f.thread.id)), null);
  assert.equal(await result(f.httpGet('ownerThreads', 'get', 'missing')), null);
});

test('background/native calls and owner GET cannot manufacture owner write authority', async (t) => {
  const f = await fixture(t);
  requirePort(f);
  await assert.rejects(() => f.host().ownerThreads.get(f.thread.id));
  await assert.rejects(() => f.native('ownerThreads', 'get', f.thread.id));
  await assert.rejects(() => f.native('ownerThreads', 'create', { title: 'native cannot create' }));
  const before = (await f.threads.list(f.owner)).map((item) => item.id);
  const denied = await f.httpGet('ownerThreads', 'create', { title: 'read cannot create' });
  assert.notEqual(denied.statusCode, 200, denied.body);
  assert.deepEqual(
    (await f.threads.list(f.owner)).map((item) => item.id),
    before,
  );
});

test('owner body cannot supply identity and invalid participants cause no mutation', async (t) => {
  const f = await fixture(t);
  requirePort(f);
  const before = (await f.threads.list(f.owner)).length;
  const forged = await f.http('ownerThreads', 'create', { title: 'forged', userId: 'another-owner' });
  assert.notEqual(forged.statusCode, 200, forged.body);
  assert.equal((await f.threads.list(f.owner)).length, before);
  for (const catIds of [['unknown'], ['cat', 'cat'], Array(51).fill('cat')]) {
    const denied = await f.http('ownerThreads', 'addParticipants', { threadId: f.thread.id, catIds });
    assert.notEqual(denied.statusCode, 200, denied.body);
  }
  assert.deepEqual((await f.threads.get(f.thread.id)).participants, []);
});

test('missing existing thread grants deny reads and writes', async (t) => {
  const f = await fixture(t, { grants: [], independentNative: true });
  requirePort(f);
  for (const [method, value] of [
    ['get', f.thread.id],
    ['create', { title: 'ungranted' }],
    ['addParticipants', { threadId: f.thread.id, catIds: ['cat'] }],
  ]) {
    const denied = await f.http('ownerThreads', method, value);
    assert.notEqual(denied.statusCode, 200, denied.body);
  }
  assert.deepEqual((await f.threads.get(f.thread.id)).participants, []);
});

test('grant revocation during an awaited thread read prevents the participant write', async (t) => {
  const f = await fixture(t);
  requirePort(f);
  const get = f.threads.get.bind(f.threads);
  let intercepted = false;
  f.threads.get = async (id, ...args) => {
    const value = await get(id, ...args);
    if (id === f.thread.id && !intercepted) {
      intercepted = true;
      await f.runtime.inventoryStore.transaction((tx) => {
        const grant = tx.grants.get(f.installed.pluginInstanceId);
        tx.grants.put({ ...grant, grantRevision: grant.grantRevision + 1, effectiveGrants: [] });
      });
    }
    return value;
  };
  const denied = await f.http('ownerThreads', 'addParticipants', { threadId: f.thread.id, catIds: ['cat'] });
  assert.equal(intercepted, true);
  assert.notEqual(denied.statusCode, 200, denied.body);
  assert.deepEqual((await get(f.thread.id)).participants, []);
});

async function ownerOperation(f, run, options = {}) {
  const { withOwnerOperationInvocation, consumeOwnerOperationInvocation } = await import(
    '../dist/domains/plugin/carrier/plugin-owner-operation-context.js'
  );
  const controller = options.controller ?? new AbortController();
  const instanceId = options.instanceId ?? f.installed.pluginInstanceId;
  const request = {
    pluginId: 'owner-operation-test',
    operationKey: 'participation',
    actionId: 'sync',
    requestId: 'owner-thread-operation',
    userId: options.userId ?? f.owner,
    signal: controller.signal,
    assertCurrent() {
      controller.signal.throwIfAborted();
    },
  };
  return withOwnerOperationInvocation(
    request,
    instanceId,
    'participation.sync',
    async () => {},
    () => consumeOwnerOperationInvocation(instanceId, 'participation.sync', undefined, () => {}, run),
  );
}

test('Settings owner operation can read, create and update its own threads through the existing carrier', async (t) => {
  const f = await fixture(t);
  await ownerOperation(f, async () => {
    assert.equal((await f.host().ownerThreads.get(f.thread.id)).id, f.thread.id);
    const created = await f.host().ownerThreads.create({ title: 'Settings participation' });
    assert.equal(created.createdBy, f.owner);
    const updated = await f.host().ownerThreads.addParticipants({ threadId: created.id, catIds: ['cat'] });
    assert.deepEqual(updated.participants, ['cat']);
    const foreign = await f.threads.create('another-owner', 'foreign');
    assert.equal(await f.host().ownerThreads.get(foreign.id), null);
  });
});

test('Settings owner operation still requires matching owner, instance and thread grants', async (t) => {
  const f = await fixture(t);
  for (const options of [{ userId: 'another-owner' }, { instanceId: 'another-instance' }]) {
    await assert.rejects(() => ownerOperation(f, () => f.host().ownerThreads.get(f.thread.id), options));
  }
  const ungranted = await fixture(t, { grants: [], independentNative: true });
  await assert.rejects(() => ownerOperation(ungranted, () => ungranted.host().ownerThreads.get(ungranted.thread.id)));
});

test('Settings operation cancellation during thread read prevents participant mutation and late return', async (t) => {
  const f = await fixture(t);
  const controller = new AbortController();
  const get = f.threads.get.bind(f.threads);
  let reached = false;
  f.threads.get = async (...args) => {
    const value = await get(...args);
    reached = true;
    controller.abort(new Error('Settings request cancelled'));
    return value;
  };
  await assert.rejects(
    () =>
      ownerOperation(f, () => f.host().ownerThreads.addParticipants({ threadId: f.thread.id, catIds: ['cat'] }), {
        controller,
      }),
    PluginOwnerOperationExpiredError,
  );
  assert.equal(reached, true);
  assert.deepEqual((await get(f.thread.id)).participants, []);
});
