import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { InvocationRegistry } from '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js';
import { invokeSingleCat } from '../dist/domains/cats/services/agents/invocation/invoke-single-cat.js';
import { InMemoryTurnExecutionStore } from '../dist/domains/cats/services/stores/memory/InMemoryTurnExecutionStore.js';

let auditDir;
let previousAuditDir;
before(async () => {
  previousAuditDir = process.env.AUDIT_LOG_DIR;
  auditDir = await mkdtemp(join(tmpdir(), 'public-child-registration-'));
  process.env.AUDIT_LOG_DIR = auditDir;
});
after(async () => {
  if (previousAuditDir === undefined) delete process.env.AUDIT_LOG_DIR;
  else process.env.AUDIT_LOG_DIR = previousAuditDir;
  await rm(auditDir, { recursive: true, force: true });
});
const binding = () => ({
  version: 1,
  entryId: 'entry-1',
  carrier: {
    version: 1,
    admissionId: 'admission-1',
    sourceMessageId: 'source-1',
    sourcePluginRevision: 1,
    pluginInstanceId: 'instance',
    packageDigest: 'digest',
    lifecycleRevision: 1,
    grantRevision: 0,
    contributionId: 'native',
    actionMethods: ['native.read'],
    targetCatId: 'codex',
    authorityRef: 'authority-1',
    authorityRevision: 'r1',
  },
});
const policy = () => ({
  mode: 'plugin_native',
  pluginInstanceId: 'instance',
  contributionId: 'native',
  actionMethods: ['native.read'],
});
function fixture(t, overrides = {}, withoutTurnStore = false) {
  const registry = new InvocationRegistry();
  const turns = new InMemoryTurnExecutionStore();
  let credentials;
  let starts = 0;
  let exposures = 0;
  const create = registry.create.bind(registry);
  registry.create = async (...args) => {
    credentials = await create(...args);
    return credentials;
  };
  const params = {
    catId: 'codex',
    service: {
      supportsToolExecutionPolicy: () => true,
      async *invoke() {
        starts++;
        yield { type: 'done', catId: 'codex', timestamp: Date.now() };
      },
    },
    prompt: 'external public input',
    userId: 'owner',
    threadId: 'thread',
    ownerAuthProvenance: 'unknown',
    isLastCat: true,
    executionCausal: { triggerMessageId: 'source-1' },
    toolExecutionPolicy: policy(),
    publicInvocationBinding: binding(),
    promptMessageIds: ['source-1'],
    onPromptMessagesExposed: async () => {
      exposures++;
    },
    ...overrides,
  };
  const deps = {
    registry,
    sessionManager: {
      get: async () => undefined,
      getOrCreate: async () => ({}),
      store: async () => {},
      delete: async () => {},
      resolveWorkingDirectory: () => auditDir,
    },
    threadStore: null,
    apiUrl: 'http://127.0.0.1:1',
    ...(withoutTurnStore ? {} : { turnExecutionStore: turns }),
  };
  const iterator = invokeSingleCat(deps, params)[Symbol.asyncIterator]();
  t.after(async () => {
    await iterator.return();
  });
  return {
    deps,
    registry,
    turns,
    params,
    iterator,
    credentials: () => credentials,
    starts: () => starts,
    exposures: () => exposures,
  };
}
async function created(f) {
  const first = await f.iterator.next();
  assert.equal(first.done, false);
  assert.equal(JSON.parse(first.value.content).type, 'invocation_created');
  assert.equal(f.starts(), 0);
  assert.equal(f.exposures(), 0);
  const issued = f.credentials();
  assert.ok(issued);
  const verified = await f.registry.verify(issued.invocationId, issued.callbackToken);
  assert.equal(verified.ok, true);
  return verified.record;
}

test('public child registration persists binding before exposing invocation_created', async (t) => {
  const f = fixture(t);
  const record = await created(f);
  assert.deepEqual(record.publicInvocationBinding, binding(), 'missing public child registration binding');
  assert.ok(Object.isFrozen(record.publicInvocationBinding.carrier.actionMethods));
  assert.equal((await f.turns.get(record.invocationId)).status, 'running');
});

test('public child registration freezes binding and policy before the first await', async (t) => {
  const f = fixture(t);
  const pending = f.iterator.next();
  f.params.publicInvocationBinding.carrier.actionMethods.push('native.admin');
  f.params.publicInvocationBinding.entryId = 'replaced';
  f.params.toolExecutionPolicy.actionMethods.push('native.admin');
  const first = await pending;
  assert.equal(JSON.parse(first.value.content).type, 'invocation_created');
  const c = f.credentials();
  const verified = await f.registry.verify(c.invocationId, c.callbackToken);
  assert.equal(verified.ok, true);
  assert.deepEqual(
    verified.record.publicInvocationBinding,
    binding(),
    'missing frozen public child registration binding',
  );
  assert.deepEqual(verified.record.toolExecutionPolicy, policy());
});

for (const [name, overrides] of [
  ['malformed marker', { publicInvocationBinding: {} }],
  ['foreign source', { executionCausal: { triggerMessageId: 'other' } }],
  ['widened native policy', { toolExecutionPolicy: { ...policy(), actionMethods: ['native.read', 'native.admin'] } }],
  ['owner authentication', { ownerAuthProvenance: 'strict' }],
  ['A2A identity', { a2aTriggerMessageId: 'source-1' }],
]) {
  test(`public child registration rejects ${name} before issuing credentials`, async (t) => {
    const f = fixture(t, overrides);
    await assert.rejects(() => f.iterator.next(), /public.*binding|public.*registration/i);
    assert.equal(f.credentials(), undefined);
    assert.equal(f.starts(), 0);
    assert.equal(f.exposures(), 0);
  });
}

test('public child registration requires durable TurnExecution before issuing credentials', async (t) => {
  const f = fixture(t, {}, true);
  await assert.rejects(() => f.iterator.next(), /public.*registration|public.*turn/i);
  assert.equal(f.credentials(), undefined);
});

test('returning a paused public child terminalizes both callback auth and TurnExecution', async (t) => {
  const f = fixture(t);
  const record = await created(f);
  await f.iterator.return();
  assert.equal((await f.turns.get(record.invocationId)).status, 'interrupted');
  const c = f.credentials();
  const verified = await f.registry.verify(c.invocationId, c.callbackToken);
  assert.equal(verified.ok, false, 'public loser child callback auth must be terminal');
  assert.equal(f.starts(), 0);
  assert.equal(f.exposures(), 0);
});

test('ordinary native child keeps absent public binding and existing iterator cleanup', async (t) => {
  const f = fixture(t, { publicInvocationBinding: undefined });
  const record = await created(f);
  assert.equal(record.publicInvocationBinding, undefined);
  await f.iterator.return();
  assert.equal((await f.turns.get(record.invocationId)).status, 'interrupted');
  assert.equal(f.starts(), 0);
});

test('public registration closes credentials when setup fails before the inner lifecycle try', async (t) => {
  const f = fixture(t, {
    promptMessageIds: {
      [Symbol.iterator]() {
        throw new Error('setup-failed');
      },
    },
  });
  await assert.rejects(() => f.iterator.next(), /setup-failed/);
  const c = f.credentials();
  assert.ok(c);
  assert.equal((await f.registry.verify(c.invocationId, c.callbackToken)).ok, false);
  assert.equal(await f.turns.get(c.invocationId), null);
});

test('public registration retains canonical canceled disposition for a paused child', async (t) => {
  const controller = new AbortController();
  const f = fixture(t, { signal: controller.signal });
  const record = await created(f);
  controller.abort();
  await f.iterator.return();
  assert.equal((await f.turns.get(record.invocationId)).status, 'canceled');
  assert.equal((await f.registry.getRecord(record.invocationId)).state, 'canceled');
});

test('public registration closes auth despite canonical terminal read outage', async (t) => {
  const f = fixture(t);
  const record = await created(f);
  f.turns.get = async () => {
    throw new Error('terminal-read-outage');
  };
  await assert.rejects(() => f.iterator.return(), /terminal-read-outage/);
  assert.equal((await f.registry.getRecord(record.invocationId)).state, 'failed');
});

test('public registration closes auth when durable terminal transition fails', async (t) => {
  const f = fixture(t);
  const record = await created(f);
  f.turns.transitionTerminal = async () => {
    throw new Error('terminal-write-outage');
  };
  await f.iterator.return();
  assert.equal((await f.turns.get(record.invocationId)).status, 'running');
  assert.equal((await f.registry.getRecord(record.invocationId)).state, 'failed');
  assert.equal(f.starts(), 0);
});

test('public registration surfaces callback terminal persistence failure to its caller', async (t) => {
  const f = fixture(t);
  const record = await created(f);
  f.registry.commitTerminal = async () => {
    throw new Error('auth-write-outage');
  };
  await assert.rejects(() => f.iterator.return(), /auth-write-outage/);
  assert.equal((await f.turns.get(record.invocationId)).status, 'interrupted');
});

test('public registration requires callback terminal support before issuing credentials', async (t) => {
  const f = fixture(t);
  f.registry.commitTerminal = undefined;
  await assert.rejects(() => f.iterator.next(), /Public child registration/);
  assert.equal(f.credentials(), undefined);
});

test('public registration keeps provider support denial before issuing credentials', async (t) => {
  const f = fixture(t);
  f.params.service.supportsToolExecutionPolicy = () => false;
  await assert.rejects(() => f.iterator.next());
  assert.equal(f.credentials(), undefined);
  assert.equal(f.exposures(), 0);
});

test('public registration closes auth after durable child registration fails', async (t) => {
  const f = fixture(t);
  f.turns.createRunning = async () => {
    throw new Error('turn-create-outage');
  };
  const messages = [];
  for await (const message of { [Symbol.asyncIterator]: () => f.iterator }) messages.push(message);
  assert.ok(messages.some((message) => message.type === 'error'));
  const c = f.credentials();
  assert.ok(c);
  assert.equal((await f.registry.verify(c.invocationId, c.callbackToken)).ok, false);
  assert.equal(f.starts(), 0);
  assert.equal(f.exposures(), 0);
});
