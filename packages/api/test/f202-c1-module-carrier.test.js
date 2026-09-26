import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { test } from 'node:test';
import { MessageStore } from '../dist/domains/cats/services/stores/ports/MessageStore.js';
import { ThreadStore } from '../dist/domains/cats/services/stores/ports/ThreadStore.js';
import { createMessagingDomain } from '../dist/domains/messaging/index.js';
import { MediaEntitlementLedger, MemoryMediaEntitlementPort } from '../dist/domains/messaging/media-entitlements.js';
import { FileMessagingMediaLedger } from '../dist/domains/messaging/media-ledger.js';
import { BundledPluginRuntimeCarrier } from '../dist/domains/plugin/builtin-runtime/bundled-runtime-carrier.js';
import { ModulePluginRuntime } from '../dist/domains/plugin/builtin-runtime/module-plugin-runtime.js';
import { PluginRuntimeCarrierRouter } from '../dist/domains/plugin/carrier/runtime-carrier.js';
import { PluginMediaReadService } from '../dist/domains/plugin/host-surface/plugin-media-host.js';
import { MemoryConnectorThreadBindingStore } from '../dist/infrastructure/connectors/ConnectorThreadBindingStore.js';

/**
 * F202 Train C1 — §8.6 steps 1 / 2 / 5 of the carrier-neutral adapter
 * (docs/plans/2026-09-19-f202-train-c1-migration-plan.md).
 *
 * Step 1: take the DEFAULT export of the module at `runtime.entrypoint`, assert `create`.
 * Step 2: the Host passes the manifest IT admitted into `create()`, never the package's
 *         self-reported copy.
 * Step 5: every teardown path reaches the runtime's disposal seam.
 *
 * These cases load a REAL file from disk through a REAL dynamic import. A recording
 * double would prove the test harness works, not that the Host can load a package.
 */

const MODULE_LOG = '__f202C1ModuleCarrierLog';

function manifest(overrides = {}) {
  return {
    pluginId: 'dev.clowder.module-fixture',
    version: '0.1.0',
    contractVersion: '0.1.0',
    name: 'Module Fixture',
    features: [{ id: 'main', name: 'Main', resources: [], capabilities: [] }],
    runtime: { transport: 'builtin', entrypoint: 'dist/plugin.js' },
    ...overrides,
  };
}

/** A real package tree with a real ESM entrypoint that records what the Host did to it. */
async function writePackage(source) {
  const rootDir = await mkdtemp(join(tmpdir(), 'f202-c1-module-'));
  await mkdir(join(rootDir, 'dist'), { recursive: true });
  await writeFile(join(rootDir, 'dist/plugin.js'), source, 'utf8');
  return rootDir;
}

const wellFormedModule = `
const log = (globalThis[${JSON.stringify(MODULE_LOG)}] ??= []);
export default {
  create(hostManifest) {
    log.push({ call: 'create', pluginId: hostManifest?.pluginId, version: hostManifest?.version });
    return {
      manifest: hostManifest,
      features: [],
      async start() {
        log.push({ call: 'start' });
        return { actions: {}, stop: async (reason) => log.push({ call: 'stop', reason }) };
      },
    };
  },
};
`;

const deliveryModule = `
const log = (globalThis[${JSON.stringify(MODULE_LOG)}] ??= []);
export default {
  create(hostManifest) {
    return {
      manifest: hostManifest,
      async start() {
        log.push({ call: 'start' });
        return {
          actions: {
            async 'host.messaging.deliver'(input) {
              log.push({ call: 'deliver', input });
              return { deliveryId: input.deliveryId };
            },
          },
          stop: async () => log.push({ call: 'stop' }),
        };
      },
    };
  },
};
`;

const invalidDeliveryReceiptModule = `
export default {
  create() {
    return {
      async start() {
        return {
          actions: {
            async 'host.messaging.deliver'() {
              return { deliveryId: 'wrong-delivery-id' };
            },
          },
          stop() {},
        };
      },
    };
  },
};
`;

const hostSurfaceModule = `
const log = (globalThis[${JSON.stringify(MODULE_LOG)}] ??= []);
export default {
  create(hostManifest) {
    return {
      manifest: hostManifest,
      async start(host) {
        log.push({
          call: 'start',
          apiBase: await host.config.get('API_BASE'),
          botToken: await host.secrets.get('BOT_TOKEN'),
        });
        host.log('info', 'module started', { pluginId: hostManifest.pluginId });
        return {
          actions: {},
          stop: async () => log.push({ call: 'stop' }),
        };
      },
    };
  },
};
`;

const threadHostModule = `
const log = (globalThis[${JSON.stringify(MODULE_LOG)}] ??= []);
export default {
  create() {
    return {
      async start(host) {
        const system = await host.threads.ensureSystemThread();
        const external = await host.threads.ensureByKey('group-42', { title: 'Group 42' });
        log.push({ call: 'threads', systemThreadId: system.id, externalThreadId: external.id });
        return { actions: {}, stop() {} };
      },
    };
  },
};
`;

const messagingHostModule = `
const log = (globalThis[${JSON.stringify(MODULE_LOG)}] ??= []);
export default {
  create() {
    return {
      async start(host) {
        const thread = await host.threads.ensureSystemThread();
        const receipt = await host.messaging.send({
          threadId: thread.id,
          idempotencyKey: 'module-send-1',
          payload: {
            provenance: { epistemicStatus: 'observation' },
            elements: [{ elementId: 'text-1', kind: 'text', payload: { text: 'module hello' } }],
          },
        });
        log.push({ call: 'messaging', receipt });
        return { actions: {}, stop() {} };
      },
    };
  },
};
`;

const subscriptionHostModule = `
const log = (globalThis[${JSON.stringify(MODULE_LOG)}] ??= []);
export default {
  create() {
    return {
      async start(host) {
        const thread = await host.threads.ensureSystemThread();
        await host.messaging.subscribe({ threadId: thread.id, method: 'fixture.outbound' });
        log.push({ call: 'subscribed', threadId: thread.id });
        return {
          actions: { 'fixture.outbound': async () => undefined },
          stop: async () => log.push({ call: 'stop' }),
        };
      },
    };
  },
};
`;

const failingSubscriptionHostModule = `
export default {
  create() {
    return {
      async start(host) {
        const thread = await host.threads.ensureSystemThread();
        await host.messaging.subscribe({ threadId: thread.id, method: 'fixture.outbound' });
        throw new Error('start failed after subscribe');
      },
    };
  },
};
`;

const invalidStartResultModule = `
const log = (globalThis[${JSON.stringify(MODULE_LOG)}] ??= []);
export default {
  create() {
    return {
      async start() {
        return {
          actions: [],
          stop: async (reason) => log.push({ call: 'stop-after-invalid-start', reason }),
        };
      },
    };
  },
};
`;

const legacyNoArgStopModule = `
const log = (globalThis[${JSON.stringify(MODULE_LOG)}] ??= []);
export default {
  create() {
    return {
      async start() {
        return { actions: {}, stop() { log.push({ call: 'legacy-stop' }); } };
      },
    };
  },
};
`;

const noCreateModule = `
export default { activate() {} };
`;

const throwingModule = `
export default {
  create() {
    throw new Error('package blew up while defining itself');
  },
};
`;

function inventoryOf(records) {
  const packages = records.map((record, index) => ({
    packageDigest: `digest-${index}`,
    pluginId: record.manifest.pluginId,
    version: record.manifest.version,
    contractVersion: record.manifest.contractVersion,
    manifest: record.manifest,
    ...(record.provenance === undefined ? {} : { provenance: record.provenance }),
    signalSchemas: {},
    packageState: 'installed',
    verifiedAt: 0,
    updatedAt: 0,
  }));
  const instances = packages.map((record, index) => ({
    pluginInstanceId: `instance-${index}`,
    pluginId: record.pluginId,
    packageDigest: record.packageDigest,
    lifecycleState: 'installed',
    configReadiness: 'ready',
    activationState: 'enabled',
    runtimeState: 'stopped',
    lifecycleRevision: 1,
    installedAt: 0,
    updatedAt: 0,
  }));
  const live = new Map(instances.map((instance) => [instance.pluginInstanceId, instance]));
  const grants = instances.map((instance, index) => ({
    pluginInstanceId: instance.pluginInstanceId,
    requestedCapabilities: records[index].effectiveGrants ?? [],
    effectiveGrants: records[index].effectiveGrants ?? [],
    grantRevision: 1,
    updatedAt: 0,
  }));
  return {
    live,
    snapshot: async () => ({ packages, instances: [...live.values()], grants }),
    transaction: async (apply) =>
      apply({
        instances: {
          get: (id) => live.get(id),
          put: (value) => live.set(value.pluginInstanceId, value),
        },
      }),
  };
}

/**
 * @param {ReadonlyArray<{manifest: object, rootDir: string, locatedManifest?: object}>} records
 */
function hostOf(records, options = {}) {
  const inventory = inventoryOf(records);
  const released = [];
  const packages = {
    resolveInstalledPackage: async (packageDigest) => {
      const index = Number(packageDigest.replace('digest-', ''));
      const record = records[index];
      if (!record) throw new Error(`no fixture package for ${packageDigest}`);
      return {
        rootDir: record.rootDir,
        manifest: record.locatedManifest ?? record.manifest,
        verifyIntegrity: record.verifyIntegrity ?? (async () => {}),
        release: async () => {
          released.push(packageDigest);
        },
      };
    },
  };
  const moduleRuntime = new ModulePluginRuntime({
    packages,
    ...(options.materializer === undefined ? {} : { materializer: options.materializer }),
    configuration: options.configuration ?? {
      readConfig: async () => undefined,
      readSecret: async () => undefined,
    },
    ...(options.threads === undefined ? {} : { threads: options.threads }),
    ...(options.messaging === undefined ? {} : { messaging: options.messaging }),
    ...(options.media === undefined ? {} : { media: options.media }),
    log: options.log ?? (() => {}),
  });
  const router = new PluginRuntimeCarrierRouter(inventory);
  router.register(new BundledPluginRuntimeCarrier({ inventory, runtimes: [moduleRuntime], now: () => 5_000 }));
  return { inventory, router, released, moduleRuntime };
}

test('loads dependency-bearing catalog modules through the verified builtin materializer', async () => {
  resetModuleLog();
  const closureRoot = await mkdtemp(join(tmpdir(), 'f202-c1-module-closure-'));
  const rootDir = join(closureRoot, 'package');
  await mkdir(join(rootDir, 'dist'), { recursive: true });
  await mkdir(join(closureRoot, 'node_modules', 'fixture-dependency'), { recursive: true });
  await writeFile(
    join(closureRoot, 'node_modules', 'fixture-dependency', 'package.json'),
    '{"name":"fixture-dependency","type":"module","exports":"./index.js"}\n',
  );
  await writeFile(
    join(closureRoot, 'node_modules', 'fixture-dependency', 'index.js'),
    'export const dependencyValue = "materialized";\n',
  );
  await writeFile(
    join(rootDir, 'dist/plugin.js'),
    `
import { dependencyValue } from 'fixture-dependency';
const log = (globalThis[${JSON.stringify(MODULE_LOG)}] ??= []);
export default {
  create() {
    return { start() { log.push({ call: 'dependency', value: dependencyValue }); return { actions: {}, stop() {} }; } };
  },
};
`,
  );
  const admitted = manifest();
  let released = 0;
  const host = hostOf(
    [
      {
        manifest: admitted,
        rootDir,
        provenance: { kind: 'catalog', catalogId: 'module-fixture', packageName: '@clowder-ai/module-fixture' },
      },
    ],
    {
      materializer: {
        async resolve(input) {
          assert.equal(input.packageName, '@clowder-ai/module-fixture');
          assert.equal(input.sourceKind, 'catalog');
          return {
            rootDir,
            manifest: admitted,
            verifyIntegrity: async () => {},
            release: async () => {
              released += 1;
            },
          };
        },
      },
    },
  );

  await host.router.start('instance-0');
  assert.deepEqual(moduleLog(), [{ call: 'dependency', value: 'materialized' }]);
  await host.router.stop('instance-0', 'host_stop');
  assert.equal(released, 1);
});

test('loads local archive modules through package metadata and the verified builtin materializer', async () => {
  resetModuleLog();
  const rootDir = await mkdtemp(join(tmpdir(), 'f202-c1-local-module-'));
  await mkdir(join(rootDir, 'dist'), { recursive: true });
  await writeFile(
    join(rootDir, 'dist/plugin.js'),
    `
const log = (globalThis[${JSON.stringify(MODULE_LOG)}] ??= []);
export default {
  create() {
    return { start() { log.push({ call: 'local-materialized' }); return { actions: {}, stop() {} }; } };
  },
};
`,
  );
  const admitted = manifest();
  let materializerCalls = 0;
  const host = hostOf(
    [
      {
        manifest: admitted,
        rootDir,
        provenance: { kind: 'local-archive', packageName: '@clowder-ai/module-fixture' },
      },
    ],
    {
      materializer: {
        async resolve(input) {
          materializerCalls += 1;
          assert.equal(input.packageName, '@clowder-ai/module-fixture');
          assert.equal(input.sourceKind, 'local-archive');
          return {
            rootDir,
            manifest: admitted,
            verifyIntegrity: async () => {},
            release: async () => {},
          };
        },
      },
    },
  );

  await host.router.start('instance-0');
  assert.equal(materializerCalls, 1);
  assert.deepEqual(moduleLog(), [{ call: 'local-materialized' }]);
  await host.router.stop('instance-0', 'host_stop');
});

function moduleLog() {
  return globalThis[MODULE_LOG] ?? [];
}

function resetModuleLog() {
  globalThis[MODULE_LOG] = [];
}

test('takes the default export of runtime.entrypoint and runs it in the Host process', async () => {
  resetModuleLog();
  const rootDir = await writePackage(wellFormedModule);
  const host = hostOf([{ manifest: manifest(), rootDir }]);

  await host.router.start('instance-0');

  assert.deepEqual(
    moduleLog().map((entry) => entry.call),
    ['create', 'start'],
    'the Host must create and start the module default export',
  );
  assert.equal(host.inventory.live.get('instance-0').runtimeState, 'healthy');
  assert.deepEqual(host.moduleRuntime.actions('instance-0'), {});

  await host.router.stop('instance-0', 'host_stop');
  assert.equal(host.moduleRuntime.actions('instance-0'), undefined, 'teardown must let the instance go');
  assert.deepEqual(
    moduleLog().map((entry) => entry.call),
    ['create', 'start', 'stop'],
    'teardown must call the stop handle returned by start()',
  );
  assert.equal(moduleLog().at(-1).reason, 'host_stop');
});

test('a legacy module with a no-argument stop still stops successfully', async () => {
  resetModuleLog();
  const rootDir = await writePackage(legacyNoArgStopModule);
  const host = hostOf([{ manifest: manifest(), rootDir }]);

  await host.router.start('instance-0');
  await host.router.stop('instance-0', 'owner_disabled');

  assert.deepEqual(moduleLog(), [{ call: 'legacy-stop' }]);
  assert.equal(host.released.length, 1);
});

test('start receives only the admitted config, secrets and log Host surface', async () => {
  resetModuleLog();
  const rootDir = await writePackage(hostSurfaceModule);
  const logs = [];
  const host = hostOf(
    [
      {
        manifest: manifest({
          configuration: [
            { key: 'API_BASE', label: 'API base', kind: 'string', required: true },
            { key: 'BOT_TOKEN', label: 'Bot token', kind: 'secret', required: true },
          ],
        }),
        rootDir,
        effectiveGrants: ['plugin.config.read', 'secret.read'],
      },
    ],
    {
      configuration: {
        readConfig: async (_instanceId, key) => (key === 'API_BASE' ? 'https://example.test' : undefined),
        readSecret: async (_instanceId, key) => (key === 'BOT_TOKEN' ? 'secret-token' : undefined),
      },
      log: (...args) => logs.push(args),
    },
  );

  await host.router.start('instance-0');

  assert.deepEqual(moduleLog(), [{ call: 'start', apiBase: 'https://example.test', botToken: 'secret-token' }]);
  assert.deepEqual(logs, [
    ['info', 'module started', { pluginId: 'dev.clowder.module-fixture', pluginInstanceId: 'instance-0' }],
  ]);
});

test('module start receives caller-bound media.read and cannot read after revocation', async () => {
  resetModuleLog();
  const rootDir = await writePackage(`
const log = (globalThis[${JSON.stringify(MODULE_LOG)}] ??= []);
export default {
  create() {
    return {
      async start(host) {
        log.push({ call: 'media', first: await host.media.read({ reference: globalThis.__f202MediaRef, offset: 0, limit: 2 }) });
        return { actions: {}, stop() {} };
      },
    };
  },
};
`);
  const ledger = new FileMessagingMediaLedger(join(rootDir, 'private-media'));
  const entitlements = new MediaEntitlementLedger(new MemoryMediaEntitlementPort());
  const reference = await ledger.register(Buffer.from('abc'), { ownerInstanceId: 'instance-0' });
  globalThis.__f202MediaRef = reference;
  const grant = await entitlements.grant({
    instanceId: 'instance-0',
    scope: { kind: 'delivery', deliveryId: 'delivery-1' },
    elementId: 'media-1',
    hmrId: reference,
  });
  const media = new PluginMediaReadService({ ledger, entitlements });
  const admitted = manifest({ features: [{ id: 'main', name: 'Main', resources: [], capabilities: ['media.read'] }] });
  const host = hostOf([{ manifest: admitted, rootDir, effectiveGrants: ['media.read'] }], { media });
  try {
    await host.router.start('instance-0');
    assert.deepEqual(moduleLog(), [
      {
        call: 'media',
        first: {
          offset: 0,
          dataBase64: 'YWI=',
          nextOffset: 2,
          done: false,
        },
      },
    ]);
    await entitlements.revoke({ grantId: grant.grantId }, 'delivery_settled');
    await assert.rejects(
      media.read(
        { pluginInstanceId: 'instance-0', effectiveGrants: ['media.read'] },
        {
          reference,
          offset: 0,
          limit: 2,
        },
      ),
      (error) => error?.code === 'MEDIA_ACCESS_DENIED',
    );
  } finally {
    await host.router.stop('instance-0', 'host_stop');
    delete globalThis.__f202MediaRef;
  }
});

test('start receives the caller-bound Host thread surface', async () => {
  resetModuleLog();
  const rootDir = await writePackage(threadHostModule);
  const threadStore = new ThreadStore();
  const bindingStore = new MemoryConnectorThreadBindingStore();
  const pluginManifest = manifest({
    features: [{ id: 'main', name: 'Main', resources: [], capabilities: ['thread.write'] }],
  });
  const host = hostOf([{ manifest: pluginManifest, rootDir, effectiveGrants: ['thread.write'] }], {
    threads: { threadStore, bindingStore, ownerUserId: 'owner-1', projectPath: '/workspace/clowder-ai' },
  });

  await host.router.start('instance-0');

  const entry = moduleLog()[0];
  assert.equal(entry.call, 'threads');
  assert.notEqual(entry.systemThreadId, entry.externalThreadId);
  assert.equal(
    (await bindingStore.getByExternal('dev.clowder.module-fixture', 'group-42')).threadId,
    entry.externalThreadId,
  );
  assert.deepEqual((await threadStore.get(entry.systemThreadId)).pluginOwnership, {
    v: 1,
    pluginInstanceId: 'instance-0',
  });
  assert.equal((await threadStore.get(entry.systemThreadId)).createdBy, 'owner-1');
  assert.equal((await threadStore.get(entry.systemThreadId)).projectPath, '/workspace/clowder-ai');
});

test('start receives the caller-bound Host messaging surface', async () => {
  resetModuleLog();
  const rootDir = await writePackage(messagingHostModule);
  const threadStore = new ThreadStore();
  const bindingStore = new MemoryConnectorThreadBindingStore();
  const messageStore = new MessageStore();
  const messaging = createMessagingDomain({ messageStore });
  const pluginManifest = manifest({
    contributions: [{ type: 'identity', id: 'fixture', displayName: 'Fixture' }],
    features: [
      {
        id: 'main',
        name: 'Main',
        resources: [],
        contributions: [{ type: 'identity', id: 'fixture' }],
        capabilities: ['messaging.send', 'thread.write'],
      },
    ],
  });
  const shared = { threadStore, bindingStore, ownerUserId: 'owner-1' };
  const host = hostOf([{ manifest: pluginManifest, rootDir, effectiveGrants: ['messaging.send', 'thread.write'] }], {
    threads: shared,
    messaging: { ...shared, service: messaging },
  });

  await host.router.start('instance-0');

  const entry = moduleLog()[0];
  assert.equal(entry.call, 'messaging');
  const stored = await messageStore.getById(entry.receipt.messageId);
  assert.equal(stored.content, 'module hello');
  assert.equal(stored.source.label, 'Fixture');
});

test('module stop unregisters every Host messaging subscription', async () => {
  resetModuleLog();
  const rootDir = await writePackage(subscriptionHostModule);
  const threadStore = new ThreadStore();
  const bindingStore = new MemoryConnectorThreadBindingStore();
  const messaging = createMessagingDomain({ messageStore: new MessageStore() });
  const registrations = [];
  const removals = [];
  const delivery = {
    register: async (declaration) => registrations.push(declaration),
    unregister: (subscriberId, threadId) => removals.push({ subscriberId, threadId }),
  };
  const shared = { threadStore, bindingStore, ownerUserId: 'owner-1' };
  const pluginManifest = manifest({
    features: [{ id: 'main', name: 'Main', resources: [], capabilities: ['message.event.subscribe', 'thread.write'] }],
  });
  const host = hostOf(
    [{ manifest: pluginManifest, rootDir, effectiveGrants: ['message.event.subscribe', 'thread.write'] }],
    {
      threads: shared,
      messaging: { ...shared, service: messaging, delivery },
    },
  );

  await host.router.start('instance-0');
  assert.equal(registrations.length, 1);
  await host.router.stop('instance-0', 'host_shutdown');

  assert.deepEqual(removals, [{ subscriberId: 'instance-0', threadId: registrations[0].threadId }]);
});

test('a module start failure unregisters subscriptions before rollback completes', async () => {
  const rootDir = await writePackage(failingSubscriptionHostModule);
  const threadStore = new ThreadStore();
  const bindingStore = new MemoryConnectorThreadBindingStore();
  const messaging = createMessagingDomain({ messageStore: new MessageStore() });
  const registrations = [];
  const removals = [];
  const delivery = {
    register: async (declaration) => registrations.push(declaration),
    unregister: (subscriberId, threadId) => removals.push({ subscriberId, threadId }),
  };
  const shared = { threadStore, bindingStore, ownerUserId: 'owner-1' };
  const pluginManifest = manifest({
    features: [{ id: 'main', name: 'Main', resources: [], capabilities: ['message.event.subscribe', 'thread.write'] }],
  });
  const host = hostOf(
    [{ manifest: pluginManifest, rootDir, effectiveGrants: ['message.event.subscribe', 'thread.write'] }],
    {
      threads: shared,
      messaging: { ...shared, service: messaging, delivery },
    },
  );

  await assert.rejects(() => host.router.start('instance-0'), /start failed after subscribe/);

  assert.equal(registrations.length, 1);
  assert.deepEqual(removals, [{ subscriberId: 'instance-0', threadId: registrations[0].threadId }]);
});

test('an invalid start result is stopped and leaves no active module behind', async () => {
  resetModuleLog();
  const rootDir = await writePackage(invalidStartResultModule);
  const host = hostOf([{ manifest: manifest(), rootDir }]);

  await assert.rejects(host.router.start('instance-0'), (error) => error.code === 'INVALID_ENTRYPOINT');

  assert.deepEqual(moduleLog(), [{ call: 'stop-after-invalid-start', reason: 'start_failed' }]);
  assert.equal(host.moduleRuntime.actions('instance-0'), undefined);
  assert.equal(host.released.length, 1, 'failed start must release the staged package');
});

test('routes the frozen Host delivery row through the selected module carrier', async () => {
  resetModuleLog();
  const rootDir = await writePackage(deliveryModule);
  const host = hostOf([{ manifest: manifest(), rootDir, effectiveGrants: ['onMessage'] }]);
  const input = {
    deliveryId: 'delivery-module-1',
    threadHandle: { kind: 'thread_handle', handle: 'thread-handle-1' },
    envelope: {
      messageId: 'message-1',
      revision: 1,
      threadId: 'thread-1',
      actor: { kind: 'cat', id: 'opus' },
      audience: { kind: 'public' },
      occurredAt: '2026-09-21T00:00:00.000Z',
      payload: {
        provenance: { epistemicStatus: 'inference', origin: { kind: 'host' } },
        elements: [{ elementId: 'e1', kind: 'text', payload: { text: 'hello' } }],
      },
    },
  };

  await host.router.start('instance-0');
  assert.deepEqual(await host.router.deliver('instance-0', input), { deliveryId: input.deliveryId });
  assert.deepEqual(moduleLog(), [{ call: 'start' }, { call: 'deliver', input }]);
});

test('module delivery fails closed when the instance lacks the published onMessage grant', async () => {
  resetModuleLog();
  const rootDir = await writePackage(deliveryModule);
  const host = hostOf([{ manifest: manifest(), rootDir }]);

  await host.router.start('instance-0');
  await assert.rejects(
    () =>
      host.router.deliver('instance-0', {
        deliveryId: 'delivery-denied',
        threadHandle: { kind: 'thread_handle', handle: 'thread-handle-1' },
        envelope: {
          messageId: 'message-denied',
          revision: 1,
          threadId: 'thread-1',
          actor: { kind: 'cat', id: 'opus' },
          audience: { kind: 'public' },
          occurredAt: '2026-09-21T00:00:00.000Z',
          payload: {
            provenance: { epistemicStatus: 'inference', origin: { kind: 'host' } },
            elements: [{ elementId: 'e1', kind: 'text', payload: { text: 'must not arrive' } }],
          },
        },
      }),
    (error) => error.code === 'DELIVERY_REJECTED',
  );
  assert.deepEqual(
    moduleLog(),
    [{ call: 'start' }],
    'delivery authority denial must stop before the package action runs',
  );
});

test('the production carrier router rejects an invalid module delivery receipt', async () => {
  const rootDir = await writePackage(invalidDeliveryReceiptModule);
  const host = hostOf([{ manifest: manifest(), rootDir, effectiveGrants: ['onMessage'] }]);
  const input = {
    deliveryId: 'delivery-invalid-receipt',
    threadHandle: { kind: 'thread_handle', handle: 'thread-handle-1' },
    envelope: {
      messageId: 'message-invalid-receipt',
      revision: 1,
      threadId: 'thread-1',
      actor: { kind: 'cat', id: 'opus' },
      audience: { kind: 'public' },
      occurredAt: '2026-09-21T00:00:00.000Z',
      payload: {
        provenance: { epistemicStatus: 'inference', origin: { kind: 'host' } },
        elements: [{ elementId: 'e1', kind: 'text', payload: { text: 'hello' } }],
      },
    },
  };

  await host.router.start('instance-0');
  await assert.rejects(
    () => host.router.deliver('instance-0', input),
    (error) => {
      assert.equal(error.code, 'PROTOCOL_VIOLATION');
      return true;
    },
  );
});

// What this pins: the Host actually hands its admitted record to `create()`. The other
// half of step 2 — that the package's own copy can never differ — is enforced by the
// authority and pinned by the drift case below, not here.
test('hands the record the Host admitted to create()', async () => {
  resetModuleLog();
  const rootDir = await writePackage(wellFormedModule);
  const host = hostOf([{ manifest: manifest(), rootDir }]);

  await host.router.start('instance-0');

  const created = moduleLog().find((entry) => entry.call === 'create');
  assert.equal(created.pluginId, 'dev.clowder.module-fixture');
  assert.equal(created.version, '0.1.0');
});

test('refuses a package whose located manifest drifts from the admitted record', async () => {
  resetModuleLog();
  const rootDir = await writePackage(wellFormedModule);
  const host = hostOf([{ manifest: manifest(), rootDir, locatedManifest: manifest({ version: '9.9.9' }) }]);

  await assert.rejects(host.router.start('instance-0'), (error) => {
    assert.equal(error.code, 'PACKAGE_AUTHORITY_MISMATCH');
    return true;
  });
  assert.equal(moduleLog().length, 0, 'a drifting package must never be imported');
});

test('refuses an entrypoint that escapes the admitted package root', async () => {
  resetModuleLog();
  // The escape target is a REAL, perfectly loadable module outside the package. If the
  // Host ever resolved entrypoints on its own instead of going through the shared
  // authority, this would import and run — so containment is the only thing that can
  // refuse it, and "the import happened to fail" cannot be mistaken for a refusal.
  const neighbour = await writePackage(wellFormedModule);
  const rootDir = await writePackage(wellFormedModule);
  const escaping = manifest({
    runtime: { transport: 'builtin', entrypoint: `../${basename(neighbour)}/dist/plugin.js` },
  });
  const host = hostOf([{ manifest: escaping, rootDir }]);

  await assert.rejects(host.router.start('instance-0'), (error) => {
    assert.equal(error.code, 'INVALID_ENTRYPOINT');
    assert.match(error.message, /escapes the admitted package root/);
    return true;
  });
  assert.equal(moduleLog().length, 0, 'an escaping entrypoint must never be imported');
});

test('reports a default export without create() as a package failure the owner can see', async () => {
  resetModuleLog();
  const rootDir = await writePackage(noCreateModule);
  const host = hostOf([{ manifest: manifest(), rootDir }]);

  await assert.rejects(host.router.start('instance-0'), (error) => {
    assert.equal(error.code, 'INVALID_ENTRYPOINT');
    return true;
  });
  const instance = host.inventory.live.get('instance-0');
  assert.equal(instance.runtimeState, 'stopped');
  assert.equal(
    instance.lastRuntimeError?.code,
    'UNEXPECTED_RUNTIME_FAILURE',
    'a malformed package must leave the owner a reason, not a silent stop',
  );
});

test('reports a module that throws while defining itself as a package failure', async () => {
  resetModuleLog();
  const rootDir = await writePackage(throwingModule);
  const host = hostOf([{ manifest: manifest(), rootDir }]);

  await assert.rejects(host.router.start('instance-0'));
  assert.equal(host.inventory.live.get('instance-0').lastRuntimeError?.code, 'UNEXPECTED_RUNTIME_FAILURE');
});

test('every teardown path releases the module instance so a restart re-creates it', async () => {
  const paths = [
    {
      name: 'host stop',
      activationState: 'enabled',
      reason: 'host_stop',
      run: (host) => host.router.stop('instance-0', 'host_stop'),
    },
    {
      name: 'owner disable',
      activationState: 'disabled',
      reason: 'owner_disabled',
      run: (host) => host.router.stop('instance-0', 'owner_disabled'),
    },
    {
      name: 'uninstall',
      activationState: 'disabling',
      reason: 'owner_uninstalled',
      run: (host) => host.router.stop('instance-0', 'owner_uninstalled'),
    },
    {
      name: 'host shutdown',
      activationState: 'enabled',
      reason: 'host_shutdown',
      run: (host) => host.router.stopAll('host_shutdown'),
    },
  ];

  for (const path of paths) {
    resetModuleLog();
    const rootDir = await writePackage(wellFormedModule);
    const host = hostOf([{ manifest: manifest(), rootDir }]);

    await host.router.start('instance-0');
    await host.inventory.transaction((transaction) => {
      const instance = transaction.instances.get('instance-0');
      transaction.instances.put({ ...instance, activationState: path.activationState, updatedAt: 6_000 });
    });

    await path.run(host);
    assert.equal(host.released.length, 1, `${path.name} must release the located package`);
    assert.equal(
      moduleLog().find((entry) => entry.call === 'stop')?.reason,
      path.reason,
      `${path.name} must deliver its reason to the module`,
    );

    await host.inventory.transaction((transaction) => {
      const instance = transaction.instances.get('instance-0');
      transaction.instances.put({ ...instance, activationState: 'enabled', updatedAt: 7_000 });
    });
    await host.router.start('instance-0');
    assert.equal(
      moduleLog().filter((entry) => entry.call === 'create').length,
      2,
      `${path.name} must leave no stale module instance behind`,
    );
  }
});

test('a failed start releases the module instance before it rolls back', async () => {
  resetModuleLog();
  const rootDir = await writePackage(throwingModule);
  const host = hostOf([{ manifest: manifest(), rootDir }]);

  await assert.rejects(host.router.start('instance-0'));

  assert.equal(host.released.length, 1, 'start-failure rollback must reach the same disposal seam');
});

test('a staged tree that changed after admission is never imported into the Host', async () => {
  resetModuleLog();
  const rootDir = await writePackage(wellFormedModule);
  let integrityCalls = 0;
  const host = hostOf([
    {
      manifest: manifest(),
      rootDir,
      verifyIntegrity: async () => {
        integrityCalls += 1;
        throw new Error('launchable package bytes changed after verified staging');
      },
    },
  ]);

  await assert.rejects(host.router.start('instance-0'), /bytes changed after verified staging/);

  assert.equal(integrityCalls, 1, 'the module carrier verifies admitted bytes exactly once');
  assert.deepEqual(moduleLog(), [], 'a tree that failed integrity must never reach dynamic import');
});
