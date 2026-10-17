import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { test } from 'node:test';
import { validateManifest } from '@clowder-ai/plugin-contract';
import { queueEntryId } from '../dist/domains/cats/services/agents/invocation/queue-ledger/QueueLedger.js';
import { createQueueLedgerAdmission } from '../dist/domains/cats/services/agents/invocation/queue-ledger/QueueLedgerAdmission.js';
import { BundledPluginRuntimeCarrier } from '../dist/domains/plugin/builtin-runtime/carriers/bundled-runtime-carrier.js';
import { ModulePluginRuntime } from '../dist/domains/plugin/builtin-runtime/carriers/module-plugin-runtime.js';
import { currentPluginCallContext, withPluginCallContext } from '../dist/domains/plugin/carrier/plugin-call-context.js';
import {
  currentOwnerOperation,
  withCurrentOwnerOperation,
} from '../dist/domains/plugin/carrier/plugin-owner-operation-context.js';
import {
  currentPluginOwnerRequestContext,
  withPluginOwnerRequest,
  withPluginOwnerWebhook,
} from '../dist/domains/plugin/carrier/plugin-owner-request-context.js';
import { currentPluginTransportPurpose } from '../dist/domains/plugin/carrier/plugin-transport-context.js';
import { PluginRuntimeCarrierRouter } from '../dist/domains/plugin/carrier/runtime-carrier.js';

const privateMethod = 'host.public-invocation.assert-current';
const manifest = {
  pluginId: 'dev.clowder.public-verifier-fixture',
  version: '0.1.0',
  contractVersion: '0.1.0',
  name: 'Public verifier fixture',
  runtime: { transport: 'builtin', entrypoint: 'plugin.mjs' },
  features: [
    {
      id: 'public',
      name: 'Public',
      resources: [],
      capabilities: ['thread.readContent'],
      contributions: [{ type: 'mcp', id: 'native' }],
    },
  ],
  contributions: [
    {
      type: 'mcp',
      id: 'native',
      runtime: { transport: 'stdio', entrypoint: 'mcp.mjs' },
      actions: [{ method: 'native.reply' }],
    },
  ],
};
function carrier() {
  return {
    version: 1,
    admissionId: 'admission',
    sourceMessageId: 'source',
    sourcePluginRevision: 1,
    pluginInstanceId: 'instance',
    packageDigest: 'fixture-digest',
    lifecycleRevision: 1,
    grantRevision: 1,
    contributionId: 'native',
    actionMethods: ['native.reply'],
    targetCatId: 'astra',
    authorityRef: 'participation:1',
    authorityRevision: 'revision:1',
  };
}
function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function fixture(
  t,
  { handler = async () => ({ current: true }), slot, actions = {}, grants = ['thread.readContent'] } = {},
) {
  const validation = validateManifest(manifest);
  assert.equal(
    validation.valid,
    true,
    `invalid public verifier fixture manifest: ${JSON.stringify(validation.errors)}`,
  );
  t.diagnostic('verified public verifier fixture manifest');
  const rootDir = await mkdtemp(join(tmpdir(), 'plugin-public-verifier-'));
  const key = randomUUID();
  let activation;
  const hook = {
    handler,
    actions,
    capture(value) {
      activation = value;
      return value;
    },
  };
  globalThis[key] = hook;
  const property = slot ?? 'publicInvocationVerifier: (...args) => hook.handler(...args),';
  await writeFile(
    join(rootDir, 'plugin.mjs'),
    `const hook = globalThis[${JSON.stringify(key)}];
    export default { create() { return { start() { return hook.capture({ actions: hook.actions,
      ${property} stop() {}
    }); } }; } };`,
  );
  await writeFile(join(rootDir, 'mcp.mjs'), 'throw new Error("This fixture must never launch an MCP process");');
  const packages = {
    resolveInstalledPackage: async () => ({
      rootDir,
      manifest: structuredClone(manifest),
      verifyIntegrity: async () => {},
      release: async () => {},
    }),
  };
  const runtime = new ModulePluginRuntime({
    packages,
    configuration: { readConfig: async () => undefined, readSecret: async () => undefined },
    log() {},
  });
  let stop = () => runtime.stop('instance', 'test_cleanup');
  t.after(async () => {
    await stop();
    delete globalThis[key];
    await rm(rootDir, { recursive: true, force: true });
  });
  const controller = new AbortController();
  const context = { signal: controller.signal, assertCurrent: async () => {} };
  return {
    rootDir,
    packages,
    setCleanup: (fn) => {
      stop = fn;
    },
    runtime,
    controller,
    context,
    hook,
    activation: () => activation,
    start: () =>
      runtime.start(
        'instance',
        { pluginId: manifest.pluginId, packageDigest: 'fixture-digest', manifest: structuredClone(manifest) },
        grants,
      ),
    invoke(value = carrier(), authority = context) {
      assert.equal(
        typeof runtime.invokePublicInvocationVerifier,
        'function',
        'missing private public verifier carrier',
      );
      return runtime.invokePublicInvocationVerifier('instance', value, authority);
    },
  };
}

test('public verifier receives detached frozen coordinates under private purpose, without native identity', async (t) => {
  let received;
  let retained;
  const entered = deferred();
  const release = deferred();
  const f = await fixture(t, {
    handler: async (input, context) => {
      received = input;
      retained = context;
      assert.equal(currentPluginCallContext('other-instance'), undefined);
      assert.equal(currentPluginCallContext('instance'), undefined);
      assert.equal(currentPluginTransportPurpose(), 'verifier');
      assert.deepEqual(Object.keys(context).sort(), ['assertCurrent', 'signal']);
      assert.ok(Object.isFrozen(input) && Object.isFrozen(input.native.methods) && Object.isFrozen(context));
      entered.resolve();
      await release.promise;
      await context.assertCurrent();
      return { current: true };
    },
  });
  await f.start();
  const original = carrier();
  const pending = withPluginCallContext(
    'other-instance',
    {
      catId: 'owner-cat',
      threadId: 'private',
      userId: 'owner',
      invocationId: 'owner-turn',
      assertCurrent: async () => {},
    },
    () => f.invoke(original),
  );
  pending.catch(() => entered.resolve());
  await entered.promise;
  original.targetCatId = 'other-cat';
  original.authorityRevision = 'other-revision';
  original.actionMethods.push('native.admin');
  release.resolve();
  const result = await pending;
  assert.deepEqual(received, {
    authority: { ref: 'participation:1', revision: 'revision:1' },
    source: { messageRef: 'message:source' },
    targetCatId: 'astra',
    native: { contributionId: 'native', methods: ['native.reply'] },
  });
  assert.deepEqual(result, { current: true });
  assert.ok(Object.isFrozen(result));
  await assert.rejects(() => retained.assertCurrent());
  assert.equal(f.runtime.exposesAction('instance', privateMethod), false);
  await assert.rejects(() => f.runtime.invoke('instance', privateMethod, {}));
});

async function routedFixture(t, options = {}) {
  const f = await fixture(t, options);
  const instance = {
    pluginInstanceId: 'instance',
    pluginId: manifest.pluginId,
    packageDigest: 'fixture-digest',
    lifecycleRevision: 1,
    lifecycleState: 'installed',
    activationState: 'enabled',
    configReadiness: 'ready',
  };
  const pkg = {
    pluginId: manifest.pluginId,
    packageDigest: 'fixture-digest',
    packageState: 'installed',
    manifest: structuredClone(manifest),
  };
  const grant = { pluginInstanceId: 'instance', grantRevision: 1, effectiveGrants: ['thread.readContent'] };
  const state = { instances: [instance], packages: [pkg], grants: [grant] };
  const inventory = {
    snapshot: async () => structuredClone(state),
    transaction: async (fn) =>
      fn({
        instances: {
          get: (id) => state.instances.find((row) => row.pluginInstanceId === id),
          put: (row) => {
            state.instances[state.instances.findIndex((old) => old.pluginInstanceId === row.pluginInstanceId)] = row;
          },
        },
      }),
  };
  const bundled = new BundledPluginRuntimeCarrier({ inventory, runtimes: [f.runtime] });
  // Installed package bytes and Host materialized resources live in separate roots.
  const projectRoot = await mkdtemp(join(tmpdir(), 'plugin-public-verifier-project-'));
  let config = { version: 1, capabilities: [] };
  const router = new PluginRuntimeCarrierRouter(
    inventory,
    {
      projectRoot,
      packages: f.packages,
      configuration: { resolve: async () => ({}) },
      mcpConfigIO: {
        readConfig: async () => config,
        withLock: async (fn) => fn(),
        writeAndRegenCli: async (value) => {
          config = structuredClone(value);
        },
      },
    },
    undefined,
    undefined,
    options.publicInvocationSources,
  );
  router.register(bundled);
  f.setCleanup(async () => {
    try {
      await router.stopAll('test_cleanup');
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });
  await router.start('instance');
  return {
    ...f,
    router,
    bundled,
    state,
    grant,
    pkg,
    invoke: (value = carrier(), ctx = f.context) => router.invokePublicInvocationVerifier('instance', value, ctx),
  };
}

test('public verifier suppresses owner HTTP and owner operation context without damaging the outer caller', async (t) => {
  const f = await fixture(t, {
    handler: async () => {
      assert.equal(currentOwnerOperation('instance'), undefined);
      assert.equal(currentPluginOwnerRequestContext('instance'), undefined);
      await Promise.resolve();
      assert.equal(currentPluginOwnerRequestContext('instance'), undefined);
      return { current: true };
    },
  });
  await f.start();
  const operation = {
    kind: 'owner-operation',
    pluginInstanceId: 'instance',
    userId: 'owner',
    operationKey: 'setting',
    actionId: 'save',
    requestId: 'request',
    signal: f.context.signal,
    assertCurrent: async () => {},
  };
  await withCurrentOwnerOperation(operation, () =>
    withPluginOwnerRequest(
      {
        pluginId: manifest.pluginId,
        contributionId: 'owner',
        userId: 'owner',
        operation: 'read',
        signal: f.context.signal,
      },
      () =>
        withPluginOwnerWebhook(
          manifest.pluginId,
          'owner',
          'instance',
          false,
          () => {},
          async () => {
            assert.equal(currentOwnerOperation('instance'), operation);
            assert.equal(currentPluginOwnerRequestContext('instance').userId, 'owner');
            assert.deepEqual(await f.invoke(), { current: true });
            assert.equal(currentOwnerOperation('instance'), operation);
            assert.equal(currentPluginOwnerRequestContext('instance').userId, 'owner');
          },
        ),
    ),
  );
});

test('a package cannot swallow a failed current fence and then return success', async (t) => {
  let fail = false;
  const f = await fixture(t, {
    handler: async (_input, ctx) => {
      fail = true;
      await assert.rejects(() => ctx.assertCurrent());
      fail = false;
      return { current: true };
    },
  });
  await f.start();
  f.context.assertCurrent = async () => {
    if (fail) throw new Error('authority revoked');
  };
  await assert.rejects(() => f.invoke());
});

test('actual Router to Bundled to Module chain uses the private verifier and never ordinary invoke', async (t) => {
  let calls = 0;
  const f = await routedFixture(t, {
    handler: () => {
      calls++;
      return { current: true };
    },
  });
  assert.deepEqual(await f.invoke(), { current: true });
  assert.equal(calls, 1);
  for (const runtime of [f.router, f.bundled, f.runtime]) {
    assert.equal(await runtime.exposesAction('instance', privateMethod), false);
    await assert.rejects(() => runtime.invoke('instance', privateMethod, carrier()));
  }
  assert.equal(calls, 1);
});

for (const [name, mutate] of [
  [
    'disabled instance',
    (f) => {
      f.state.instances[0].activationState = 'disabled';
    },
  ],
  [
    'lifecycle revision',
    (f) => {
      f.state.instances[0].lifecycleRevision++;
    },
  ],
  [
    'grant revision',
    (f) => {
      f.grant.grantRevision++;
    },
  ],
  [
    'effective grants without revision change',
    (f) => {
      f.grant.effectiveGrants = [];
    },
  ],
  [
    'package mutation under same digest',
    (f) => {
      f.pkg.manifest.name = 'Changed';
    },
  ],
]) {
  test(`routed public verifier rejects ${name} before entering the package`, async (t) => {
    let calls = 0;
    const f = await routedFixture(t, {
      handler: () => {
        calls++;
        return { current: true };
      },
    });
    mutate(f);
    await assert.rejects(() => f.invoke());
    assert.equal(calls, 0);
  });
}

test('routed public verifier rejects authority revision changed while package work is pending', async (t) => {
  const entered = deferred();
  const release = deferred();
  const f = await routedFixture(t, {
    handler: async () => {
      entered.resolve();
      await release.promise;
      return { current: true };
    },
  });
  const pending = f.invoke();
  const rejected = assert.rejects(pending);
  await entered.promise;
  f.grant.grantRevision++;
  release.resolve();
  await rejected;
});

test('routed stop cancels pending verifier without waiting for the package', async (t) => {
  const entered = deferred();
  const release = deferred();
  const f = await routedFixture(t, {
    handler: async () => {
      entered.resolve();
      await release.promise;
      return { current: true };
    },
  });
  const pending = f.invoke();
  const rejected = assert.rejects(pending);
  await entered.promise;
  await f.router.stop('instance', 'revoked');
  await rejected;
  release.resolve();
});

test('missing private verifier fails closed and never calls an ordinary fallback', async (t) => {
  let calls = 0;
  const f = await fixture(t, {
    slot: '',
    actions: {
      'native.reply': () => {
        calls++;
        return { current: true };
      },
    },
  });
  await f.start();
  await assert.rejects(async () => f.invoke());
  assert.equal(calls, 0);
  // A missing API is an implementation gap, not evidence that a rejection path exists.
  assert.equal(typeof f.runtime.invokePublicInvocationVerifier, 'function', 'missing private public verifier carrier');
});

test('private verifier rejects instance, digest, contribution and undeclared method mismatches before package entry', async (t) => {
  let calls = 0;
  const f = await fixture(t, {
    handler: () => {
      calls++;
      return { current: true };
    },
  });
  await f.start();
  assert.equal(typeof f.runtime.invokePublicInvocationVerifier, 'function', 'missing private public verifier carrier');
  for (const delta of [
    { pluginInstanceId: 'other' },
    { packageDigest: 'other' },
    { contributionId: 'other' },
    { actionMethods: ['native.admin'] },
    { actionMethods: [] },
  ]) {
    await assert.rejects(() => f.invoke({ ...carrier(), ...delta }));
  }
  assert.equal(calls, 0);
});

test('activation captures the verifier function rather than rereading a mutable returned object', async (t) => {
  let oldCalls = 0;
  let replacementCalls = 0;
  const f = await fixture(t, {
    handler: () => {
      oldCalls++;
      return { current: true };
    },
  });
  await f.start();
  f.activation().publicInvocationVerifier = () => {
    replacementCalls++;
    return { current: true };
  };
  assert.deepEqual(await f.invoke(), { current: true });
  assert.equal(oldCalls, 1);
  assert.equal(replacementCalls, 0);
});

test('authority is checked across awaits and the original fence cannot be replaced by the caller', async (t) => {
  let valid = true;
  let calls = 0;
  const entered = deferred();
  const release = deferred();
  const f = await fixture(t, {
    handler: () => {
      calls++;
      return { current: true };
    },
  });
  await f.start();
  const ctx = {
    signal: f.context.signal,
    assertCurrent: async () => {
      entered.resolve();
      await release.promise;
      assert.ok(valid, 'authority revoked');
    },
  };
  const pending = Promise.resolve().then(() => f.invoke(carrier(), ctx));
  pending.catch(() => entered.resolve());
  await entered.promise;
  ctx.assertCurrent = async () => {};
  valid = false;
  release.resolve();
  await assert.rejects(pending, /authority revoked/);
  assert.equal(calls, 0);
});

for (const reason of ['stop', 'abort']) {
  test(`pending public verifier rejects on ${reason} and ignores late success`, async (t) => {
    const entered = deferred();
    const release = deferred();
    let retained;
    const f = await fixture(t, {
      handler: async (_input, ctx) => {
        retained = ctx;
        entered.resolve();
        await release.promise;
        return { current: true };
      },
    });
    await f.start();
    assert.equal(
      typeof f.runtime.invokePublicInvocationVerifier,
      'function',
      'missing private public verifier carrier',
    );
    const pending = f.invoke();
    const rejected = assert.rejects(pending);
    await entered.promise;
    if (reason === 'stop') await f.runtime.stop('instance', 'revoked');
    else f.controller.abort();
    // Cancellation must settle without cooperation from the package handler.
    await rejected;
    release.resolve();
    await assert.rejects(() => retained.assertCurrent());
  });
}

test('private verifier accepts only current true and forbids result fields that could replace authority', async (t) => {
  let result;
  const f = await fixture(t, { handler: () => result });
  await f.start();
  assert.equal(typeof f.runtime.invokePublicInvocationVerifier, 'function', 'missing private public verifier carrier');
  for (result of [
    undefined,
    null,
    true,
    { current: false },
    { current: true, targetCatId: 'other' },
    { current: true, native: { methods: ['admin'] } },
  ]) {
    await assert.rejects(() => f.invoke());
  }
});

for (const [name, slot] of [
  ['accessor', 'get publicInvocationVerifier() { throw new Error("accessor must not execute"); },'],
  ['inherited', '__proto__: { publicInvocationVerifier: () => ({ current: true }) },'],
  ['nonfunction', 'publicInvocationVerifier: {},'],
]) {
  test(`activation rejects a ${name} public verifier slot`, async (t) => {
    const f = await fixture(t, { slot });
    await assert.rejects(f.start, { code: 'PROTOCOL_VIOLATION' });
  });
}

test('fixed private verifier name cannot be registered as an ordinary action', async (t) => {
  const f = await fixture(t, { actions: { [privateMethod]: () => ({ current: true }) } });
  await assert.rejects(f.start, { code: 'PROTOCOL_VIOLATION' });
});

test('a public verifier cannot approve an MCP contribution whose owning feature is not granted', async (t) => {
  let calls = 0;
  const f = await fixture(t, {
    grants: [],
    handler: () => {
      calls++;
      return { current: true };
    },
  });
  await f.start();
  assert.equal(typeof f.runtime.invokePublicInvocationVerifier, 'function', 'missing private public verifier carrier');
  await assert.rejects(() => f.invoke());
  assert.equal(calls, 0);
});

async function publicSourceFixture(t, options = {}) {
  const message = {
    id: 'source',
    userId: 'owner',
    threadId: 'public-thread',
    catId: null,
    content: 'public source body',
    timestamp: 1000,
    mentions: [],
    deliveryStatus: 'queued',
    from: { kind: 'plugin', instanceId: 'instance' },
    extra: {
      pluginMessage: {
        instanceId: 'instance',
        revision: 1,
        presentation: { connector: 'fixture', label: 'Fixture', icon: 'message', meta: { channel: 'public' } },
      },
      privateSecret: 'do not project',
    },
  };
  const row = createQueueLedgerAdmission({
    sourceId: message.id,
    messageId: message.id,
    threadId: message.threadId,
    owner: { kind: 'user', userId: 'owner' },
    from: message.from,
    kind: 'conversation_input',
    targetCatIds: ['astra'],
    content: message.content,
    intent: 'execute',
    ownerAuthProvenance: 'unknown',
    autoExecute: true,
    enqueuedAt: 1000,
    pluginPublicInvocation: carrier(),
  })[0];
  const response = {
    id: 'response',
    userId: 'owner',
    threadId: message.threadId,
    from: { kind: 'agent', catId: 'astra' },
    lifecycle: {
      kind: 'response',
      orderKey: '1001:child',
      invocationId: 'child-1',
      targetId: 'astra',
      inputEntryIds: [row.id],
      inputMessageIds: [message.id],
      status: 'processing',
      startedAt: 1001,
    },
  };
  function bindChild() {
    message.lifecycle = {
      kind: 'input',
      orderKey: '1000:source',
      dispatchRefs: [{ targetId: 'astra', phase: 'dispatched', statusMessageId: response.id, dispatchedAt: 1001 }],
    };
  }

  const thread = { id: 'public-thread', createdBy: 'owner', participants: ['astra'] };
  const stores = {
    ownerUserId: 'owner',
    messageStore: {
      getById: async (id) => structuredClone(id === message.id ? message : id === response.id ? response : null),
    },
    queue: { getDurableEntry: async () => structuredClone(row) },
    threadStore: { get: async (id) => (id === thread.id ? structuredClone(thread) : null) },
  };
  let entered = 0;
  const f = await routedFixture(t, {
    publicInvocationSources: stores,
    handler: async (input, context) => {
      entered++;
      return options.handler ? options.handler(input, context) : { current: true };
    },
  });
  const binding = { entryId: queueEntryId(message.id), userId: 'owner', threadId: thread.id, targetCatId: 'astra' };
  assert.equal(typeof f.router.assertPublicInvocationCurrent, 'function', 'missing durable public currentness fence');
  return {
    ...f,
    message,
    row,
    response,
    bindChild,
    thread,
    stores,
    binding,
    entered: () => entered,
    check: (value = carrier(), expected = binding, context = f.context) =>
      f.router.assertPublicInvocationCurrent('instance', value, expected, context),
  };
}

test('public source fence verifies durable custody through the real private runtime chain', async (t) => {
  const f = await publicSourceFixture(t);
  assert.equal(await f.check(), undefined);
  assert.equal(f.entered(), 1);
  assert.equal(f.message.deliveryStatus, 'queued');
  assert.equal(f.row.status, 'queued');
});

test('public source fence rejects missing, recalled, deleted, foreign and malformed sources before package entry', async (t) => {
  const f = await publicSourceFixture(t);
  const original = structuredClone(f.message);
  for (const delta of [
    { id: 'missing' },
    { userId: 'foreign' },
    { from: { kind: 'agent', catId: 'astra' } },
    { threadId: 'foreign' },
    { recall: { recalledAt: 1 } },
    { deletedAt: 1 },
    { _tombstone: true },
    { sourceParseFailure: {} },
    { extra: { pluginMessage: { instanceId: 'instance', revision: 1 } } },
    { deliveryStatus: 'canceled' },
    { extra: { pluginMessage: { instanceId: 'other', revision: 1 } } },
    { extra: { pluginMessage: { instanceId: 'instance', revision: 2 } } },
  ]) {
    for (const key of Object.keys(f.message)) delete f.message[key];
    Object.assign(f.message, structuredClone(original), delta);
    await assert.rejects(() => f.check());
  }
  assert.equal(f.entered(), 0);
});

test('public source fence rejects substituted Queue identity and execution authority', async (t) => {
  const f = await publicSourceFixture(t);
  const original = structuredClone(f.row);
  for (const mutate of [
    (r) => {
      r.execution.pluginPublicInvocation = undefined;
    },
    (r) => {
      r.execution.pluginPublicInvocation.authorityRevision = 'other';
    },
    (r) => {
      r.id = 'other';
    },
    (r) => {
      r.owner.userId = 'foreign';
    },
    (r) => {
      r.execution.ownerAuthProvenance = 'strict';
    },
    (r) => {
      r.targets = ['astra', 'codex'];
    },
  ]) {
    const row = structuredClone(original);
    mutate(row);
    f.stores.queue.getDurableEntry = async () => row;
    await assert.rejects(() => f.check());
  }
  f.stores.queue.getDurableEntry = async () => undefined;
  await assert.rejects(() => f.check());
  assert.equal(f.entered(), 0);
});
test('public source fence rejects retired or terminal rows without requeue', async (t) => {
  const f = await publicSourceFixture(t);
  for (const delta of [{ status: 'terminal' }, { targets: [] }, { retiringGroupId: 'retired' }]) {
    const row = { ...structuredClone(f.row), ...delta };
    f.stores.queue.getDurableEntry = async () => row;
    await assert.rejects(() => f.check());
    assert.deepEqual(row, { ...f.row, ...delta });
  }
  assert.equal(f.entered(), 0);
});

test('public source fence requires current owner thread and target participation', async (t) => {
  const f = await publicSourceFixture(t);
  for (const thread of [
    null,
    { ...f.thread, createdBy: 'foreign' },
    { ...f.thread, deletedAt: 1 },
    { ...f.thread, participants: [] },
    { ...f.thread, id: 'other' },
  ]) {
    f.stores.threadStore.get = async () => thread;
    await assert.rejects(() => f.check());
  }
  assert.equal(f.entered(), 0);
});

test('public source fence rejects malformed caller bindings before store reads', async (t) => {
  const f = await publicSourceFixture(t);
  let reads = 0;
  f.stores.messageStore.getById = async () => {
    reads++;
    return f.message;
  };
  for (const delta of [
    { userId: 'foreign' },
    { targetCatId: 'codex' },
    { entryId: '' },
    { threadId: '' },
    { workspace: '/private' },
    { invocationId: '' },
  ]) {
    await assert.rejects(() => f.check(carrier(), { ...f.binding, ...delta }));
  }
  assert.equal(reads, 0);
});

test('public source fence rejects source body drift during thread lookup even without a revision bump', async (t) => {
  const f = await publicSourceFixture(t);
  f.stores.threadStore.get = async () => {
    f.message.content = 'replaced';
    return f.thread;
  };
  await assert.rejects(() => f.check());
  assert.equal(f.entered(), 0);
});

test('public source fence rejects source withdrawal while package verification awaits', async (t) => {
  const entered = deferred(),
    release = deferred();
  const f = await publicSourceFixture(t, {
    handler: async () => {
      entered.resolve();
      await release.promise;
      return { current: true };
    },
  });
  const pending = f.check();
  await entered.promise;
  f.message.recall = { recalledAt: 1001 };
  release.resolve();
  await assert.rejects(() => pending);
});

test('public source fence cannot lose a failed source check swallowed by the package', async (t) => {
  let f;
  f = await publicSourceFixture(t, {
    handler: async (_input, context) => {
      f.thread.participants = [];
      await assert.rejects(() => context.assertCurrent());
      f.thread.participants = ['astra'];
      return { current: true };
    },
  });
  await assert.rejects(() => f.check());
});

test('public source fence captures carrier and binding before awaited reads', async (t) => {
  const f = await publicSourceFixture(t);
  const entered = deferred(),
    release = deferred();
  const get = f.stores.messageStore.getById;
  f.stores.messageStore.getById = async (id) => {
    entered.resolve();
    await release.promise;
    return get(id);
  };
  const value = carrier(),
    binding = { ...f.binding };
  const pending = f.check(value, binding);
  await entered.promise;
  value.authorityRevision = 'mutated';
  value.actionMethods.push('native.admin');
  binding.entryId = 'mutated';
  release.resolve();
  assert.equal(await pending, undefined);
});

test('public source fence binds callbacks to the exact History child', async (t) => {
  const f = await publicSourceFixture(t);
  f.bindChild();
  await f.check(carrier(), { ...f.binding, invocationId: 'child-1' });
  await assert.rejects(() => f.check(carrier(), { ...f.binding, invocationId: 'child-2' }));
  await assert.rejects(() => f.check());
  f.response.lifecycle.status = 'completed';
  await assert.rejects(() => f.check(carrier(), { ...f.binding, invocationId: 'child-1' }));
  f.response.lifecycle.status = 'processing';
  f.message.lifecycle.dispatchRefs[0].phase = 'settled';
  await assert.rejects(() => f.check(carrier(), { ...f.binding, invocationId: 'child-1' }));
});

test('public source fence rejects stopped activation and aborted calls', async (t) => {
  const f = await publicSourceFixture(t);
  const abort = new AbortController();
  abort.abort(new Error('cancelled'));
  await assert.rejects(() => f.check(carrier(), f.binding, { ...f.context, signal: abort.signal }));
  await f.router.stop('instance', 'owner_disabled');
  await assert.rejects(() => f.check());
  assert.equal(f.entered(), 0);
});

test('public source fence rechecks activation during source reads after package verification', async (t) => {
  let verified = false;
  const f = await publicSourceFixture(t, {
    handler: async () => {
      verified = true;
      return { current: true };
    },
  });
  const get = f.stores.messageStore.getById;
  let stopped = false;
  f.stores.messageStore.getById = async (id) => {
    const message = await get(id);
    if (verified && !stopped) {
      stopped = true;
      await f.router.stop('instance', 'disabled_during_final_source_read');
    }
    return message;
  };
  await assert.rejects(() => f.check());
  assert.equal(verified, true);
  assert.equal(stopped, true);
});

test('public source fence abort settles blocked storage reads without entering the package', async (t) => {
  const f = await publicSourceFixture(t);
  const entered = deferred(),
    release = deferred();
  const get = f.stores.messageStore.getById;
  f.stores.messageStore.getById = async (id) => {
    entered.resolve();
    await release.promise;
    return get(id);
  };
  const controller = new AbortController();
  const pending = f.check(carrier(), f.binding, { ...f.context, signal: controller.signal });
  await entered.promise;
  controller.abort(new Error('abort_storage_read'));
  try {
    await assert.rejects(() => pending, /abort_storage_read/);
    assert.equal(f.entered(), 0);
  } finally {
    release.resolve();
  }
});

async function publicLaunchFixture(t, options = {}) {
  const f = await publicSourceFixture(t, options);
  f.bindChild();
  f.binding.invocationId = 'child-1';
  return f;
}

function launchResolver(f) {
  assert.equal(typeof f.router.resolvePublicInvocationLaunch, 'function', 'missing source-bound public launch lease');
  return (value = carrier(), expected = f.binding, context = f.context) =>
    f.router.resolvePublicInvocationLaunch('instance', value, expected, context);
}

test('public launch fixture has current processing custody and exact child before resolution', async (t) => {
  const f = await publicLaunchFixture(t);
  await f.check();
  assert.equal(f.entered(), 1);
});

test('public launch lease returns only frozen verified source and exact native descriptor', async (t) => {
  const f = await publicLaunchFixture(t);
  const resolve = launchResolver(f);
  const lease = await resolve();
  t.after(() => lease.dispose());
  assert.deepEqual(Object.keys(lease).sort(), ['assertCurrent', 'dispose', 'server', 'source']);
  assert.deepEqual(lease.source, { messageId: 'source', content: 'public source body' });
  assert.ok(Object.isFrozen(lease) && Object.isFrozen(lease.source));
  assert.ok(Object.isFrozen(lease.server) && Object.isFrozen(lease.server.args) && Object.isFrozen(lease.server.env));
  assert.equal(lease.server.transport, 'stdio');
  assert.ok(lease.server.env.CLOWDER_PLUGIN_ACTION_TOKEN);
  assert.equal(JSON.stringify(lease.source).includes('do not project'), false);
  await lease.assertCurrent();
  assert.equal(f.response.lifecycle.status, 'processing');
});

test('public launch lease refuses queue-level and wrong-child authority', async (t) => {
  const f = await publicLaunchFixture(t);
  const resolve = launchResolver(f);
  const { invocationId: _child, ...queued } = f.binding;
  await assert.rejects(() => resolve(carrier(), queued));
  await assert.rejects(() => resolve(carrier(), { ...f.binding, invocationId: 'child-2' }));
  f.message.lifecycle.dispatchRefs[0].phase = 'settled';
  await assert.rejects(() => resolve(carrier(), queued));
});

test('public launch lease pins source bytes across separate checks and permanently latches failure', async (t) => {
  const f = await publicLaunchFixture(t);
  const lease = await launchResolver(f)();
  t.after(() => lease.dispose());
  f.message.content = 'changed without revision';
  await assert.rejects(() => lease.assertCurrent());
  f.message.content = 'public source body';
  await assert.rejects(() => lease.assertCurrent());
  assert.equal(lease.source.content, 'public source body');
});

test('public launch lease pins source provenance even when body and plugin revision are unchanged', async (t) => {
  const f = await publicLaunchFixture(t);
  const lease = await launchResolver(f)();
  t.after(() => lease.dispose());
  f.message.extra.pluginMessage.presentation.meta.channel = 'private';
  await assert.rejects(() => lease.assertCurrent());
});

test('public launch lease rejects authority revocation after initial resolution', async (t) => {
  let authorized = true;
  const f = await publicLaunchFixture(t, { handler: async () => ({ current: authorized }) });
  const lease = await launchResolver(f)();
  t.after(() => lease.dispose());
  authorized = false;
  await assert.rejects(() => lease.assertCurrent());
  authorized = true;
  await assert.rejects(() => lease.assertCurrent());
});

test('public launch lease rejects grant drift after initial resolution', async (t) => {
  const f = await publicLaunchFixture(t);
  const lease = await launchResolver(f)();
  t.after(() => lease.dispose());
  f.grant.grantRevision++;
  await assert.rejects(() => lease.assertCurrent());
});

test('public launch lease cannot renew itself across stop and reactivation', async (t) => {
  const f = await publicLaunchFixture(t);
  const lease = await launchResolver(f)();
  t.after(() => lease.dispose());
  await f.router.stop('instance', 'test_reactivation');
  await f.router.start('instance');
  await assert.rejects(() => lease.assertCurrent());
});

test('public launch lease captures coordinates and caller fence before the first await', async (t) => {
  const f = await publicLaunchFixture(t);
  const resolve = launchResolver(f);
  const entered = deferred(),
    release = deferred();
  const value = carrier(),
    binding = { ...f.binding };
  let calls = 0;
  const context = {
    signal: f.controller.signal,
    assertCurrent: async () => {
      calls++;
      entered.resolve();
      await release.promise;
    },
  };
  const pending = resolve(value, binding, context);
  await entered.promise;
  value.actionMethods.push('native.admin');
  binding.invocationId = 'child-2';
  context.assertCurrent = async () => {
    throw new Error('replacement fence must not run');
  };
  release.resolve();
  const lease = await pending;
  t.after(() => lease.dispose());
  await lease.assertCurrent();
  assert.ok(calls > 1);
});

test('public launch lease rejects body drift during its initial package verification', async (t) => {
  let f;
  f = await publicLaunchFixture(t, {
    handler: async () => {
      f.message.content = 'changed during verification';
      return { current: true };
    },
  });
  await assert.rejects(() => launchResolver(f)());
});

test('public launch lease dispose invalidates retained and pending checks without waiting for storage', async (t) => {
  const f = await publicLaunchFixture(t);
  const lease = await launchResolver(f)();
  const entered = deferred(),
    release = deferred();
  const get = f.stores.messageStore.getById;
  f.stores.messageStore.getById = async (id) => {
    entered.resolve();
    await release.promise;
    return get(id);
  };
  const pending = lease.assertCurrent();
  const rejected = assert.rejects(pending);
  await entered.promise;
  try {
    await lease.dispose();
    await lease.dispose();
    await rejected;
    await assert.rejects(() => lease.assertCurrent());
  } finally {
    release.resolve();
  }
});

test('public launch lease abort settles initial blocked source reads without returning authority', async (t) => {
  const f = await publicLaunchFixture(t);
  const resolve = launchResolver(f);
  const entered = deferred(),
    release = deferred();
  const get = f.stores.messageStore.getById;
  f.stores.messageStore.getById = async (id) => {
    entered.resolve();
    await release.promise;
    return get(id);
  };
  const pending = resolve();
  const rejected = assert.rejects(pending);
  await entered.promise;
  try {
    f.controller.abort(new Error('test_launch_abort'));
    await rejected;
  } finally {
    release.resolve();
  }
});

test('public launch lease refuses deleted source and never exposes an ordinary fallback', async (t) => {
  const f = await publicLaunchFixture(t);
  const resolve = launchResolver(f);
  f.message.deletedAt = 1002;
  await assert.rejects(() => resolve());
});

test('public launch lease keeps a failed caller fence latched after caller authority returns', async (t) => {
  const f = await publicLaunchFixture(t);
  let valid = true;
  const lease = await launchResolver(f)(carrier(), f.binding, {
    signal: f.controller.signal,
    assertCurrent: async () => {
      assert.ok(valid, 'caller revoked');
    },
  });
  t.after(() => lease.dispose());
  valid = false;
  await assert.rejects(() => lease.assertCurrent(), /caller revoked/);
  valid = true;
  await assert.rejects(() => lease.assertCurrent(), /caller revoked/);
});

test('public launch lease invalidation rejects every concurrent pending check', async (t) => {
  const f = await publicLaunchFixture(t);
  const lease = await launchResolver(f)();
  const entered = deferred(),
    release = deferred();
  const get = f.stores.messageStore.getById;
  let blocked = 0;
  f.stores.messageStore.getById = async (id) => {
    if (++blocked === 2) entered.resolve();
    await release.promise;
    return get(id);
  };
  const first = assert.rejects(lease.assertCurrent());
  const second = assert.rejects(lease.assertCurrent());
  await entered.promise;
  try {
    lease.dispose();
    await Promise.all([first, second]);
  } finally {
    release.resolve();
  }
});

function executionPreparer(f) {
  assert.equal(
    typeof f.router.preparePublicInvocationExecution,
    'function',
    'missing owned public execution preparation',
  );
  return (value = carrier(), expected = f.binding, context = f.context) =>
    f.router.preparePublicInvocationExecution('instance', value, expected, context);
}

async function publicWorkspaceRoots() {
  return (await readdir(tmpdir())).filter((name) => name.startsWith('clowder-public-invocation-')).sort();
}

test('public prepare returns verified source and an empty canonical private workspace', async (t) => {
  const f = await publicLaunchFixture(t);
  const prepare = executionPreparer(f);
  const prepared = await prepare();
  t.after(() => prepared.dispose());
  assert.deepEqual(Object.keys(prepared).sort(), ['dispose', 'launch', 'source']);
  assert.deepEqual(prepared.source, { messageId: 'source', content: 'public source body' });
  assert.equal(prepared.launch.sandbox.kind, 'public');
  const root = prepared.launch.sandbox.workspaceRoot;
  assert.ok(isAbsolute(root));
  assert.equal(await realpath(root), root);
  assert.equal((await lstat(root)).mode & 0o777, 0o700);
  assert.deepEqual(await readdir(root), []);
  assert.ok(Object.isFrozen(prepared) && Object.isFrozen(prepared.launch) && Object.isFrozen(prepared.launch.sandbox));
  assert.ok(Object.isFrozen(prepared.source) && Object.isFrozen(prepared.launch.server));
  await prepared.launch.assertCurrent();
});

test('public prepare owns separate workspaces and disposal cannot affect another preparation', async (t) => {
  const f = await publicLaunchFixture(t);
  const prepare = executionPreparer(f);
  const first = await prepare(),
    second = await prepare();
  t.after(() => second.dispose());
  assert.notEqual(first.launch.sandbox.workspaceRoot, second.launch.sandbox.workspaceRoot);
  await writeFile(join(first.launch.sandbox.workspaceRoot, 'owned-output'), 'temporary provider output');
  await first.dispose();
  await assert.rejects(() => lstat(first.launch.sandbox.workspaceRoot), { code: 'ENOENT' });
  await second.launch.assertCurrent();
  assert.deepEqual(await readdir(second.launch.sandbox.workspaceRoot), []);
});

test('public prepare refuses revoked authority before allocating any workspace', async (t) => {
  const f = await publicLaunchFixture(t, { handler: async () => ({ current: false }) });
  const prepare = executionPreparer(f);
  const before = await publicWorkspaceRoots();
  await assert.rejects(() => prepare());
  assert.deepEqual(await publicWorkspaceRoots(), before);
});

test('public prepare removes partial allocation when cancellation arrives during its post-allocation fence', async (t) => {
  const f = await publicLaunchFixture(t);
  const prepare = executionPreparer(f);
  const before = await publicWorkspaceRoots();
  const entered = deferred(),
    release = deferred();
  const pending = prepare(carrier(), f.binding, {
    signal: f.controller.signal,
    assertCurrent: async () => {
      if ((await publicWorkspaceRoots()).some((name) => !before.includes(name))) {
        entered.resolve();
        await release.promise;
      }
    },
  });
  pending.catch(() => entered.resolve());
  const rejected = assert.rejects(pending);
  await entered.promise;
  f.controller.abort(new Error('prepare_aborted_after_allocation'));
  release.resolve();
  await rejected;
  assert.deepEqual(await publicWorkspaceRoots(), before);
});

test('public prepare permanently latches source revocation after allocation', async (t) => {
  const f = await publicLaunchFixture(t);
  const prepared = await executionPreparer(f)();
  t.after(() => prepared.dispose());
  f.message.content = 'changed public body';
  await assert.rejects(() => prepared.launch.assertCurrent());
  f.message.content = 'public source body';
  await assert.rejects(() => prepared.launch.assertCurrent());
  assert.equal(prepared.source.content, 'public source body');
});

test('public prepare disposal is idempotent and permanently invalidates launch authority', async (t) => {
  const f = await publicLaunchFixture(t);
  const prepared = await executionPreparer(f)();
  const root = prepared.launch.sandbox.workspaceRoot;
  await Promise.all([prepared.dispose(), prepared.dispose()]);
  await prepared.dispose();
  await assert.rejects(() => prepared.launch.assertCurrent());
  await assert.rejects(() => lstat(root), { code: 'ENOENT' });
});

test('public prepare caller abort revokes the lease and still permits owned cleanup', async (t) => {
  const f = await publicLaunchFixture(t);
  const prepared = await executionPreparer(f)();
  f.controller.abort(new Error('caller_aborted'));
  await assert.rejects(() => prepared.launch.assertCurrent());
  await prepared.dispose();
  await assert.rejects(() => lstat(prepared.launch.sandbox.workspaceRoot), { code: 'ENOENT' });
});

test('public prepare detects workspace permission drift and does not recover after chmod restoration', async (t) => {
  const f = await publicLaunchFixture(t);
  const prepared = await executionPreparer(f)();
  t.after(() => prepared.dispose());
  const root = prepared.launch.sandbox.workspaceRoot;
  await chmod(root, 0o755);
  await assert.rejects(() => prepared.launch.assertCurrent());
  await chmod(root, 0o700);
  await assert.rejects(() => prepared.launch.assertCurrent());
});

test('public prepare detects inode replacement and refuses to delete the replacement tree', async (t) => {
  const f = await publicLaunchFixture(t);
  const prepared = await executionPreparer(f)();
  const root = prepared.launch.sandbox.workspaceRoot;
  const moved = `${root}-test-moved`;
  await rename(root, moved);
  await mkdir(root, { mode: 0o700 });
  await writeFile(join(root, 'replacement-sentinel'), 'replacement must survive');
  try {
    await assert.rejects(() => prepared.launch.assertCurrent());
    await assert.rejects(() => prepared.dispose());
    assert.equal(await readFile(join(root, 'replacement-sentinel'), 'utf8'), 'replacement must survive');
  } finally {
    // Both paths were created by this test, not by a user or a running instance.
    await rm(root, { recursive: true, force: true });
    await rename(moved, root);
    await prepared.dispose();
  }
});

test('public prepare rejects symlink replacement without deleting the link target', async (t) => {
  const f = await publicLaunchFixture(t);
  const prepared = await executionPreparer(f)();
  const root = prepared.launch.sandbox.workspaceRoot;
  const moved = `${root}-test-moved`;
  const target = await mkdtemp(join(tmpdir(), 'public-prepare-symlink-target-'));
  await writeFile(join(target, 'sentinel'), 'target must survive');
  await rename(root, moved);
  await symlink(target, root, 'dir');
  try {
    await assert.rejects(() => prepared.launch.assertCurrent());
    await assert.rejects(() => prepared.dispose());
    assert.equal(await readFile(join(target, 'sentinel'), 'utf8'), 'target must survive');
  } finally {
    await rm(root, { force: true });
    await rename(moved, root);
    await prepared.dispose();
    await rm(target, { recursive: true, force: true });
  }
});

test('public prepare disposal settles blocked currentness without waiting for its storage read', async (t) => {
  const f = await publicLaunchFixture(t);
  const prepared = await executionPreparer(f)();
  const entered = deferred(),
    release = deferred();
  const get = f.stores.messageStore.getById;
  f.stores.messageStore.getById = async (id) => {
    entered.resolve();
    await release.promise;
    return get(id);
  };
  const rejected = assert.rejects(prepared.launch.assertCurrent());
  await entered.promise;
  try {
    await prepared.dispose();
    await rejected;
    await assert.rejects(() => lstat(prepared.launch.sandbox.workspaceRoot), { code: 'ENOENT' });
  } finally {
    release.resolve();
  }
});

test('public prepare snapshots binding and caller fence before awaiting source authority', async (t) => {
  const f = await publicLaunchFixture(t);
  const prepare = executionPreparer(f);
  const entered = deferred(),
    release = deferred();
  const value = carrier(),
    expected = { ...f.binding };
  const context = {
    signal: f.controller.signal,
    assertCurrent: async () => {
      entered.resolve();
      await release.promise;
    },
  };
  const pending = prepare(value, expected, context);
  await entered.promise;
  expected.invocationId = 'foreign-child';
  value.sourceMessageId = 'private-source';
  context.assertCurrent = async () => {
    throw new Error('replacement must not run');
  };
  release.resolve();
  const prepared = await pending;
  t.after(() => prepared.dispose());
  await prepared.launch.assertCurrent();
  assert.equal(prepared.source.messageId, 'source');
});

test('public prepare integrates with child execution using only verified source and disposes after done', async (t) => {
  const f = await publicLaunchFixture(t);
  const prepare = executionPreparer(f);
  const { executePublicInvocation } = await import(
    '../dist/domains/cats/services/agents/invocation/public-invocation-execution.js'
  );
  let root;
  let exposed = false;
  let calls = 0;
  const iterator = executePublicInvocation({
    port: { prepare: async () => prepare() },
    invocationId: 'child-1',
    catId: 'astra',
    sourceMessageId: 'source',
    signal: f.controller.signal,
    policy: {
      mode: 'plugin_native',
      pluginInstanceId: 'instance',
      contributionId: 'native',
      actionMethods: ['native.reply'],
    },
    callbackEnv: {},
    expose: async () => {
      exposed = true;
    },
    close: async (provider) => {
      await provider.return();
      return true;
    },
    service: {
      async *invoke(prompt, options) {
        calls++;
        assert.ok(exposed);
        assert.equal(prompt, 'public source body');
        root = options.workingDirectory;
        assert.equal(root, options.pluginNativeLaunch.sandbox.workspaceRoot);
        await options.pluginNativeLaunch.assertCurrent();
        assert.deepEqual(await readdir(root), []);
        yield { type: 'done', catId: 'astra', timestamp: 1003 };
      },
    },
  });
  const result = [];
  for await (const event of iterator) result.push(event.type);
  assert.deepEqual(result, ['done']);
  assert.equal(calls, 1);
  await assert.rejects(() => lstat(root), { code: 'ENOENT' });
});

test('public prepare cleans the real workspace when child execution returns while provider is paused', async (t) => {
  const f = await publicLaunchFixture(t);
  const prepare = executionPreparer(f);
  const { executePublicInvocation } = await import(
    '../dist/domains/cats/services/agents/invocation/public-invocation-execution.js'
  );
  let root;
  let closed = 0;
  const iterator = executePublicInvocation({
    port: { prepare: async () => prepare() },
    invocationId: 'child-1',
    catId: 'astra',
    sourceMessageId: 'source',
    signal: f.controller.signal,
    policy: {
      mode: 'plugin_native',
      pluginInstanceId: 'instance',
      contributionId: 'native',
      actionMethods: ['native.reply'],
    },
    callbackEnv: {},
    expose: async () => {},
    close: async (provider) => {
      await provider.return();
      return true;
    },
    service: {
      async *invoke(_prompt, options) {
        root = options.workingDirectory;
        try {
          yield { type: 'text', content: 'public result', catId: 'astra', timestamp: 1003 };
        } finally {
          closed++;
        }
      },
    },
  });
  assert.equal((await iterator.next()).value.type, 'text');
  await iterator.return();
  assert.equal(closed, 1);
  await assert.rejects(() => lstat(root), { code: 'ENOENT' });
});
