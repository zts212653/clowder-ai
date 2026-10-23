import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { test } from 'node:test';
import { createThreadDeepLinkUrl } from '../dist/config/frontend-origin.js';
import './helpers/setup-cat-registry.js';
import { MessageStore } from '../dist/domains/cats/services/stores/ports/MessageStore.js';
import { TaskStore } from '../dist/domains/cats/services/stores/ports/TaskStore.js';
import { ThreadStore } from '../dist/domains/cats/services/stores/ports/ThreadStore.js';
import { EntrustedWorkOwnerReadService } from '../dist/domains/growing/EntrustedWorkOwnerReadService.js';
import { F232PreparedArtifactReader } from '../dist/domains/growing/F232PreparedArtifactReader.js';
import { createMessagingDomain } from '../dist/domains/messaging/index.js';
import { MediaEntitlementLedger, MemoryMediaEntitlementPort } from '../dist/domains/messaging/media-entitlements.js';
import { FileMessagingMediaLedger } from '../dist/domains/messaging/media-ledger.js';
import { BundledPluginRuntimeCarrier } from '../dist/domains/plugin/builtin-runtime/carriers/bundled-runtime-carrier.js';
import { ModulePluginRuntime } from '../dist/domains/plugin/builtin-runtime/carriers/module-plugin-runtime.js';
import { PluginRuntimeCarrierRouter } from '../dist/domains/plugin/carrier/runtime-carrier.js';
import { PluginMediaReadService } from '../dist/domains/plugin/host-surface/plugin-media-host.js';
import { MemoryConnectorThreadBindingStore } from '../dist/infrastructure/connectors/ConnectorThreadBindingStore.js';

/**
 * F202 Train C1 — §8.6 steps 1 / 2 / 5 of the carrier-neutral adapter
 * (docs/features/F202-plugin-framework.md).
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
        return { actions: {}, stop: async ({ reason }) => log.push({ call: 'stop', reason }) };
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
        const system = await host.threads.create({ title: 'Fixture' });
        const external = await host.threads.create({ title: 'Group 42' });
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
        const thread = await host.threads.create({ title: 'Fixture' });
        const receipt = await host.messaging.send({
          threadId: thread.id,
          idempotencyKey: 'module-send-1',
          payload: {
            provenance: { epistemicStatus: 'observation', origin: { kind: 'plugin', instanceId: host.pluginInstanceId } },
            elements: [{ elementId: 'text-1', kind: 'text', payload: { text: 'module hello' } }],
          },
        });
        log.push({ call: 'messaging', receipt, read: await host.messaging.get(receipt.messageId) });
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
        const thread = await host.threads.create({ title: 'Fixture' });
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
        const thread = await host.threads.create({ title: 'Fixture' });
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
          stop: async ({ reason }) => log.push({ call: 'stop-after-invalid-start', reason }),
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
    dataDirectoryParent: options.dataDirectoryParent ?? join(records[0].rootDir, 'test-host-data'),
    ...options.taskServices,
    ...(options.materializer === undefined ? {} : { materializer: options.materializer }),
    configuration: options.configuration ?? {
      readConfig: async () => undefined,
      readSecret: async () => undefined,
    },
    ...(options.threads === undefined
      ? {}
      : {
          threads: {
            threadDeepLinkUrl: createThreadDeepLinkUrl('https://cafe.example.test'),
            ...options.threads,
          },
        }),
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

test('module start receives the actual installation id for each instance of the same package', async () => {
  resetModuleLog();
  const rootDir = await writePackage(`
export default { create() { return { async start(host) {
  globalThis[${JSON.stringify(MODULE_LOG)}].push(host.pluginInstanceId);
  return { actions: {}, stop() {} };
} }; } };
`);
  const record = { manifest: manifest(), rootDir };
  const host = hostOf([record, record]);
  try {
    await host.router.start('instance-0');
    assert.deepEqual(moduleLog(), ['instance-0']);
    await host.router.stop('instance-0', 'reload');
    await host.router.start('instance-0');
    assert.deepEqual(moduleLog(), ['instance-0', 'instance-0']);
    await host.router.stop('instance-0', 'uninstall');
    host.inventory.live.get('instance-0').lifecycleState = 'uninstalled';
    await host.router.start('instance-1');
    assert.deepEqual(moduleLog(), ['instance-0', 'instance-0', 'instance-1']);
  } finally {
    await host.moduleRuntime.stop('instance-0', 'test_finished');
    await host.moduleRuntime.stop('instance-1', 'test_finished');
  }
});

test('module config preserves declared scalar types while secrets remain strings', async () => {
  resetModuleLog();
  const rootDir = await writePackage(`
export default { create() { return { async start(host) {
  globalThis[${JSON.stringify(MODULE_LOG)}].push(await Promise.all([
    host.config.get('disabled'), host.config.get('enabled'), host.config.get('limit'),
    host.secrets.get('token'),
  ]));
  return { actions: {}, stop() {} };
} }; } };
`);
  const host = hostOf(
    [
      {
        rootDir,
        manifest: manifest({
          configuration: [
            { key: 'disabled', label: 'Disabled', kind: 'boolean', required: false, default: false },
            { key: 'enabled', label: 'Enabled', kind: 'boolean', required: false },
            { key: 'limit', label: 'Limit', kind: 'number', required: false },

            { key: 'token', label: 'Token', kind: 'secret', required: false },
          ],
        }),
        effectiveGrants: ['plugin.config.read', 'secret.read'],
      },
    ],
    {
      configuration: {
        readConfig: async (_id, key) => ({ enabled: 'true', limit: '12' })[key],
        readSecret: async () => 'false',
      },
    },
  );
  await host.router.start('instance-0');
  assert.deepEqual(moduleLog(), [[false, true, 12, 'false']]);
  await host.router.stop('instance-0');
});

test('module configuration rejects malformed typed storage before package activation', async () => {
  for (const [kind, value] of [
    ['boolean', 'FALSE'],
    ['number', 'Infinity'],
    ['number', '  '],
  ]) {
    resetModuleLog();
    const rootDir = await writePackage(wellFormedModule);
    const host = hostOf(
      [
        {
          rootDir,
          manifest: manifest({ configuration: [{ key: 'setting', label: 'Setting', kind, required: false }] }),
          effectiveGrants: ['plugin.config.read'],
        },
      ],
      { configuration: { readConfig: async () => value, readSecret: async () => undefined } },
    );
    await assert.rejects(host.router.start('instance-0'), /Invalid .* configuration field setting/);
    assert.equal(
      moduleLog().some((entry) => entry.call === 'start'),
      false,
    );
    assert.equal(host.released.length, 1, 'failed projection releases the verified package');
  }
});

test('module start receives caller-bound streams.read and cannot read after revocation', async () => {
  resetModuleLog();
  const rootDir = await writePackage(`
const log = (globalThis[${JSON.stringify(MODULE_LOG)}] ??= []);
export default {
  create() {
    return {
      async start(host) {
        const chunks = []; for await (const bytes of host.streams.read(globalThis.__f202MediaRef)) chunks.push(Buffer.from(bytes));
        log.push({call:'stream', bytes:Buffer.concat(chunks).toString()});
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
  const admitted = manifest({
    features: [{ id: 'main', name: 'Main', resources: [], capabilities: ['streams.read'] }],
  });
  const host = hostOf([{ manifest: admitted, rootDir, effectiveGrants: ['streams.read'] }], { media });
  try {
    await host.router.start('instance-0');
    assert.deepEqual(moduleLog(), [{ call: 'stream', bytes: 'abc' }]);
    await entitlements.revoke({ grantId: grant.grantId }, 'delivery_settled');
    await assert.rejects(
      async () => {
        for await (const _ of media.stream(
          { pluginInstanceId: 'instance-0', effectiveGrants: ['streams.read'] },
          reference,
        )) {
        }
      },
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
  assert.equal(await bindingStore.getByExternal('dev.clowder.module-fixture', 'group-42'), null);
  assert.equal((await threadStore.get(entry.systemThreadId)).pluginOwnership, undefined);
  assert.equal((await threadStore.get(entry.systemThreadId)).createdBy, 'owner-1');
  assert.equal((await threadStore.get(entry.systemThreadId)).projectPath, '/workspace/clowder-ai');
});

test('a real builtin module consumes thread listing, safe history, roster and routing patches', async () => {
  resetModuleLog();
  const rootDir = await writePackage(`
    export default { create() { return { async start(host) {
      const thread = await (await host.threads.list({ limit: 1 }))[0];
      await host.threads.update(thread.id, { preferredCats: ['a'] });
      globalThis[${JSON.stringify(MODULE_LOG)}].push({
        thread: await host.threads.get(thread.id), list: await host.threads.list({ limit: 1 }),
        whereReply: 'Current thread: ' + (await host.threads.get(thread.id)).deepLinkUrl,
        messages: await host.threads.readMessages(thread.id, { limit: 5 }),
        cats: await host.threads.getCats(thread.id),
      });
      return { actions: {}, stop() {} };
    } }; } };
  `);
  const threadStore = new ThreadStore();
  const messageStore = new MessageStore();
  const bindingStore = new MemoryConnectorThreadBindingStore();
  const existing = await threadStore.create('owner-1', 'Existing');
  await bindingStore.bind('dev.clowder.module-fixture', 'projection', existing.id, 'owner-1');
  await messageStore.append({
    from: { kind: 'user', userId: 'owner-1' },
    threadId: existing.id,
    userId: 'owner-1',
    timestamp: 1,
    content: 'hello',
  });
  const grants = ['thread.write', 'thread.listMetadata', 'thread.readContent'];
  const pluginManifest = manifest({ features: [{ id: 'main', name: 'Main', resources: [], capabilities: grants }] });
  const host = hostOf([{ manifest: pluginManifest, rootDir, effectiveGrants: grants }], {
    threads: {
      threadStore,
      messageStore,
      bindingStore,
      ownerUserId: 'owner-1',
      projectPath: '/workspace/clowder-ai',
      cats: {
        getAllCatIds: () => ['a'],
        getCatDisplayName: () => 'A',
        getCatAliases: () => ['@a'],
        isCatAvailable: () => true,
        getRegisteredServices: () => new Map([['a', {}]]),
      },
    },
  });
  try {
    await host.router.start('instance-0');
    const entry = moduleLog()[0];
    assert.deepEqual(entry.thread.preferredCats, ['a']);
    assert.equal(entry.list[0].id, existing.id);
    assert.equal(entry.thread.deepLinkUrl, `https://cafe.example.test/thread/${existing.id}`);
    assert.equal(entry.list[0].deepLinkUrl, entry.thread.deepLinkUrl);
    assert.equal(entry.whereReply, `Current thread: https://cafe.example.test/thread/${existing.id}`);
    assert.equal(entry.messages[0].content, 'hello');
    assert.deepEqual(entry.cats.routableNotJoined, [{ catId: 'a', displayName: 'A', aliases: ['@a'] }]);
    assert.deepEqual((await threadStore.get(existing.id)).preferredCats, ['a']);
  } finally {
    await host.router.stop('instance-0', 'host_stop');
  }
});

test('real builtin thread surface paginates past fifty owner threads', async () => {
  resetModuleLog();
  const rootDir = await writePackage(`
    export default { create() { return { async start(host) {
      const rows = [];
      let before;
      for (let page = 0; page < 3; page++) {
        const batch = await host.threads.list({ limit: 50, ...(before ? { before } : {}) });
        rows.push(...batch);
        if (batch.length < 50) break;
        const last = batch.at(-1);
        before = { lastActiveAt: last.lastActiveAt, id: last.id };
      }
      globalThis[${JSON.stringify(MODULE_LOG)}].push(rows.map(row => row.id));
      return { actions: {}, stop() {} };
    } }; } };
  `);
  const threadStore = new ThreadStore();
  const expected = [];
  for (let index = 0; index < 51; index++) {
    const thread = await threadStore.create('owner-1', `Thread ${index}`);
    thread.lastActiveAt = 100 - index;
    expected.push(thread.id);
  }
  await threadStore.create('other-owner', 'Hidden');
  const grants = ['thread.listMetadata'];
  const pluginManifest = manifest({ features: [{ id: 'main', name: 'Main', resources: [], capabilities: grants }] });
  const host = hostOf([{ manifest: pluginManifest, rootDir, effectiveGrants: grants }], {
    threads: { threadStore, bindingStore: new MemoryConnectorThreadBindingStore(), ownerUserId: 'owner-1' },
  });
  try {
    await host.router.start('instance-0');
    assert.deepEqual(moduleLog()[0], expected);
  } finally {
    await host.router.stop('instance-0', 'host_stop');
  }
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
        capabilities: ['messaging.send', 'thread.write', 'thread.readContent'],
      },
    ],
  });
  const shared = { threadStore, bindingStore, ownerUserId: 'owner-1' };
  const host = hostOf(
    [{ manifest: pluginManifest, rootDir, effectiveGrants: ['messaging.send', 'thread.write', 'thread.readContent'] }],
    {
      threads: shared,
      messaging: { ...shared, service: messaging, messageStore },
    },
  );

  await host.router.start('instance-0');

  const entry = moduleLog()[0];
  assert.equal(entry.call, 'messaging');
  const stored = await messageStore.getById(entry.receipt.messageId);
  assert.equal(stored.content, 'module hello');
  assert.equal(entry.read.id, stored.id);
  assert.equal(entry.read.content, stored.content);
  assert.equal(stored.extra.pluginMessage.presentation.label, 'Fixture');
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
    kind: 'message',
    threadId: 'thread-1',
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
        kind: 'message',
        threadId: 'thread-1',
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
    kind: 'message',
    threadId: 'thread-1',
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
    assert.equal(
      host.released.length,
      path.reason === 'owner_uninstalled' ? 2 : 1,
      `${path.name} must release both runtime and any separate settings-only uninstall load`,
    );
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
      path.reason === 'owner_uninstalled' ? 3 : 2,
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

test('real module Task data writes reach original Schedule projection and change notifications without dispatch', async () => {
  const tasks = new TaskStore(),
    messages = new MessageStore(),
    threads = new ThreadStore();
  const thread = threads.create('owner', 'Schedule');
  threads.addParticipants(thread.id, ['codex']);
  const source = messages.append({
    from: { kind: 'plugin', instanceId: 'instance-0' },
    userId: 'owner',
    threadId: thread.id,

    content: 'Produce the report.',
    timestamp: 1,
    extra: { pluginMessage: { instanceId: 'instance-0', revision: 1, provenance: {}, elements: [], appendOps: [] } },
  });
  const artifactRef = '/uploads/module-report.md';
  messages.append({
    from: { kind: 'agent', catId: 'codex' },
    userId: 'owner',
    threadId: thread.id,

    content: 'Report',
    timestamp: 100,
    extra: { rich: { blocks: [{ kind: 'file', v: 1, id: 'module-report', fileName: 'report.md', url: artifactRef }] } },
  });
  const artifactReader = new F232PreparedArtifactReader({ messages });
  const rootDir = await writePackage(`
    export default {create(){return {async start(host){
      const task=await host.tasks.create(${JSON.stringify({ threadId: thread.id, title: 'Report', subjectKey: 'module:report', ownerCatId: 'codex', entrustedWork: { sourceMessageId: source.id, intendedOutcome: 'Report', closure: { condition: 'Report accepted', expectedSignal: 'accepted' }, time: { businessDeadline: { value: 1900000000000, sourceRef: `message:${source.id}` } } } })}, { onConflict: 'update' });
      const read=await host.tasks.get({ id: task.id });
      if(read.entrustedWork.time.businessDeadline.value!==1900000000000) throw Error('missing deadline');
      const selected=await host.tasks.update(task.id,{entrustedWork:{expectedRevision:read.entrustedWork.revision,artifactRefs:[${JSON.stringify(artifactRef)}]}});
      const selectedRead=await host.tasks.get({ id: task.id });
      if(selectedRead.entrustedWork.artifactRefs[0]!==${JSON.stringify(artifactRef)}) throw Error('missing selection');
      await host.tasks.update(task.id,{entrustedWork:{expectedRevision:selected.entrustedWork.revision,closure:{condition:'Report accepted',expectedSignal:'accepted',state:'satisfied',evidenceRefs:['service:accepted']}}});
      return {actions:{},stop(){}};
    }}}};
  `);
  const controllerAuthority = Object.freeze({
    pluginId: 'dev.clowder.module-fixture',
    pluginInstanceId: 'instance-0',
    moduleRef: 'plugin:dev.clowder.module-fixture',
    lifecycleRevision: 1,
    grantRevision: 1,
    effectiveGrants: ['task.read', 'task.write', 'task.admitEntrusted'],
  });
  const taskAdmission = (includeControllerAuthority) => async () => ({
    messageStore: messages,
    isCatAvailable: (id) => id === 'codex',
    assertCurrent: async () => {},
    ...(includeControllerAuthority
      ? {
          readCurrentDataControllerAuthority: async () => controllerAuthority,
          withCurrentDataControllerAuthority: async (run) => run(controllerAuthority),
        }
      : {}),
  });
  const record = { manifest: manifest(), rootDir, effectiveGrants: controllerAuthority.effectiveGrants };
  const missingAuthorityHost = hostOf([record], {
    taskServices: {
      taskStore: new TaskStore(),
      taskArtifactReader: artifactReader,
      taskOwnerUserId: 'owner',
      taskThreadStore: threads,
      taskAdmission: taskAdmission(false),
    },
  });
  await assert.rejects(
    missingAuthorityHost.router.start('instance-0'),
    (error) => {
      assert.equal(error.code, 'DELIVERY_REJECTED');
      assert.match(error.message, /Host Task data-controller authority is unavailable/);
      return true;
    },
    'real module writes must fail closed when Host controller authority is not wired',
  );
  const changes = [];
  const host = hostOf([record], {
    taskServices: {
      taskStore: tasks,
      taskArtifactReader: artifactReader,
      taskOwnerUserId: 'owner',
      taskThreadStore: threads,
      taskAdmission: taskAdmission(true),
      onTaskDataChanged: (task) => changes.push(task.id),
    },
  });
  await host.router.start('instance-0');
  const schedule = await new EntrustedWorkOwnerReadService({
    tasks,
    artifactReader,
    producerCatalog: {
      listCurrentReceipts: async () => [],
      readCurrentReceipts: async () => ({ receipts: [], coverage: { state: 'complete' } }),
    },
  }).listForOwner('owner', 'completed');
  assert.equal(schedule.length, 1);
  assert.equal(schedule[0].timeRefs.find((ref) => ref.role === 'business_deadline').value, 1900000000000);
  assert.equal(schedule[0].preparedArtifact.artifactRef, artifactRef);
  assert.deepEqual(changes, Array(3).fill(tasks.getBySubject('module:report').id));
  assert.equal(messages.getRecent(100, 'owner').length, 2);
  await host.router.stop('instance-0', 'host_stop');
});

test('installed module exposes Task data and ordinary send without legacy execution producers', async () => {
  const rootDir = await writePackage(`
    import assert from 'node:assert/strict';
    export default { create() { return { async start(host) {
      assert.equal(host.tasks.prepareEntrusted, undefined);
      assert.equal(host.tasks.dispatchEntrusted, undefined);
      assert.equal(host.taskArtifacts, undefined);
      assert.equal(typeof host.tasks.create, 'function');
      assert.equal(typeof host.tasks.update, 'function');
      assert.equal(typeof host.messaging.send, 'function');
      return { actions: {}, stop() {} };
    } }; } };
  `);
  const host = hostOf([{ manifest: manifest(), rootDir }]);
  await host.router.start('instance-0');
  await host.router.stop('instance-0', 'host_shutdown');
});

test('loaded settings uses the original data path without a separate grant without starting runtime', async (t) => {
  const rootDir = await writePackage(`
    import { readFile } from 'node:fs/promises';
    import { join } from 'node:path';
    export default { create() { return {
      start() { throw new Error('settings must not start the adapter'); },
      settings(host) { return { actions: { inspect: async () => ({
        directory: host.dataPath,
        binding: host.dataPath ? await readFile(join(host.dataPath, 'conversation-binding.json'), 'utf8') : null,
        secret: await host.secrets.get('TOKEN'),
      }) } }; }
    }; } };
  `);
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  const parent = join(rootDir, 'host-data');
  const directory = join(parent, 'personal-chrome-host');
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'conversation-binding.json'), '{"original":true}');
  const admitted = manifest({
    runtime: { transport: 'builtin', entrypoint: 'dist/plugin.js', dataDirectory: 'personal-chrome-host' },
    features: [{ id: 'settings', name: 'Settings', resources: [], capabilities: ['secret.read'] }],
    configuration: [{ key: 'TOKEN', kind: 'secret', label: 'Token', required: true }],
    test: { action: { method: 'inspect' } },
  });
  const host = hostOf([{ manifest: admitted, rootDir }], { dataDirectoryParent: parent });
  const record = (await host.inventory.snapshot()).packages[0];
  const input = {
    pluginInstanceId: 'instance-0',
    packageRecord: record,
    effectiveGrants: ['secret.read'],
    method: 'inspect',
    params: {},
    assertCurrent: async () => {},
  };
  const result = await host.moduleRuntime.invokeSettings(input);
  assert.deepEqual(result, { handled: true, result: { directory, binding: '{"original":true}', secret: undefined } });
  const withoutGrant = await host.moduleRuntime.invokeSettings({ ...input, effectiveGrants: ['secret.read'] });
  assert.equal(withoutGrant.result.directory, directory);
  assert.equal(await readFile(join(directory, 'conversation-binding.json'), 'utf8'), '{"original":true}');
  await assert.rejects(
    host.moduleRuntime.invokeSettings({
      ...input,
      assertCurrent: async () => {
        throw new Error('stale');
      },
    }),
    /stale/,
  );
  assert.equal(host.released.length, 3);
});

test('loaded settings consumes the one-shot HTTP owner authority and leaves the commit fence current', async (t) => {
  const { withOwnerOperationInvocation } = await import(
    '../dist/domains/plugin/carrier/plugin-owner-operation-context.js'
  );
  const rootDir = await writePackage(
    `export default {create(){return {start(){throw Error('no runtime');},settings(){return {actions:{inspect:async(_params,_caller,owner)=>{await owner.assertCurrent();return {userId:owner.userId,kind:owner.kind};}}};}};}};`,
  );
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  const host = hostOf([{ manifest: manifest({ test: { action: { method: 'inspect' } } }), rootDir }]);
  const record = (await host.inventory.snapshot()).packages[0];
  const bound = [];
  const controller = new AbortController();
  const request = {
    pluginId: record.pluginId,
    operationKey: 'inspect',
    actionId: 'inspect',
    userId: 'owner',
    requestId: 'request',
    signal: controller.signal,
    assertCurrent() {
      assert.equal(controller.signal.aborted, false);
    },
    bindActivation(check) {
      bound.push(check);
    },
  };
  const result = await withOwnerOperationInvocation(
    request,
    'instance-0',
    'inspect',
    async () => {},
    () =>
      host.moduleRuntime.invokeSettings({
        pluginInstanceId: 'instance-0',
        packageRecord: record,
        effectiveGrants: [],
        method: 'inspect',
        params: {},
        assertCurrent: async () => {},
      }),
  );
  assert.deepEqual(result, { handled: true, result: { userId: 'owner', kind: 'owner-operation' } });
  for (const check of bound) check(); // Disposal of a settings carrier must not invalidate the subsequent Host commit.
  assert.equal(host.released.length, 1);
});

test('module lifecycle hooks wrap start and stop; disabled uninstall never starts business work', async (t) => {
  resetModuleLog();
  const rootDir = await writePackage(`
    const log = globalThis[${JSON.stringify(MODULE_LOG)}] ??= [];
    export default { create() { return {
      preStart(host) { log.push({call:'preStart', path:host.dataPath}); },
      start(host) { log.push({call:'start'}); return {
        actions: {},
        configRefresh() { log.push({call:'configRefresh'}); },
        preStop({reason, deadline}) { log.push({call:'preStop', reason, deadline}); },
        stop({reason}) { log.push({call:'stop', reason}); }
      }; },
      preUninstall(host) { log.push({call:'preUninstall', path:host.dataPath}); },
      uninstall() { log.push({call:'uninstall'}); }
    }; } };
  `);
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  const h = hostOf([{ manifest: manifest(), rootDir }], { dataDirectoryParent: join(rootDir, 'data') });
  await h.router.start('instance-0');
  await h.router.stop('instance-0', 'owner_disabled');
  assert.deepEqual(
    moduleLog().map((x) => x.call),
    ['preStart', 'start', 'preStop', 'stop'],
  );
  assert.equal(moduleLog()[0].path, join(rootDir, 'data', 'dev.clowder.module-fixture'));
  assert.ok(Number.isFinite(moduleLog()[2].deadline));
  await h.router.stop('instance-0', 'owner_uninstalled');
  assert.deepEqual(
    moduleLog().map((x) => x.call),
    ['preStart', 'start', 'preStop', 'stop', 'preUninstall', 'uninstall'],
  );
});

test('configRefresh replaces cached credentials and a failed refresh cannot keep serving old handlers', async (t) => {
  let token = 'first';
  const rootDir = await writePackage(`export default {create(){return {async start(host){
    let cached=await host.secrets.get('TOKEN');
    return {actions:{read:async()=>cached},async configRefresh(){cached=undefined; const next=await host.secrets.get('TOKEN'); if(next==='bad')throw Error('refresh failed'); cached=next;},stop(){cached=undefined;}};
  }}}};`);
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  const h = hostOf(
    [
      {
        manifest: manifest({ configuration: [{ key: 'TOKEN', label: 'Token', kind: 'secret', required: true }] }),
        rootDir,
        effectiveGrants: ['secret.read'],
      },
    ],
    { configuration: { readConfig: async () => undefined, readSecret: async () => token } },
  );
  await h.router.start('instance-0');
  assert.equal(await h.router.invoke('instance-0', 'read', {}), 'first');
  token = 'second';
  await h.router.configRefresh('instance-0');
  assert.equal(await h.router.invoke('instance-0', 'read', {}), 'second');
  token = 'bad';
  await assert.rejects(h.router.configRefresh('instance-0'), /refresh failed/);
  await assert.rejects(h.router.invoke('instance-0', 'read', {}));
});

test('absent configRefresh hook does not stop or restart a stateless module', async (t) => {
  resetModuleLog();
  const rootDir = await writePackage(`const log = globalThis[${JSON.stringify(MODULE_LOG)}] ??= [];
    export default {create(){return {start(){log.push({call:'start'});return {actions:{read:()=> 'current'},stop(){log.push({call:'stop'});}};}};}};`);
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  const h = hostOf([{ manifest: manifest(), rootDir }]);
  await h.router.start('instance-0');
  await h.router.configRefresh('instance-0');
  assert.equal(await h.router.invoke('instance-0', 'read', {}), 'current');
  assert.deepEqual(
    moduleLog().map((x) => x.call),
    ['start'],
  );
  await h.router.stop('instance-0', 'owner_disabled');
});

async function settingsProbeFixture(t, { hook = false, failStart = false, materialized = true } = {}) {
  const rootDir = await writePackage(`export default { create() { return {
    ${hook ? "settings() { return { actions: { inspect: () => 'settings' } }; }," : ''}
    start() {
      ${failStart ? "throw Error('startup failed');" : ''}
      return { actions: { inspect: (_input, _caller, owner) => owner?.userId ?? 'runtime' }, stop() {} };
    }
  }; } };`);
  const admitted = manifest({ test: { action: { method: 'inspect' } } });
  let resolutions = 0;
  const verified = () => ({ rootDir, manifest: admitted, verifyIntegrity: async () => {}, release: async () => {} });
  const packageRecord = {
    ...(await inventoryOf([{ manifest: admitted, rootDir }]).snapshot()).packages[0],
    ...(materialized ? { provenance: { kind: 'local-archive', packageName: '@clowder-ai/module-fixture' } } : {}),
  };
  const runtime = new ModulePluginRuntime({
    packages: {
      async resolveInstalledPackage() {
        resolutions++;
        return verified();
      },
    },
    materializer: {
      async resolve() {
        resolutions++;
        return verified();
      },
    },
    configuration: { readConfig: async () => undefined, readSecret: async () => undefined },
    dataDirectoryParent: join(rootDir, 'data'),
    log() {},
  });
  t.after(async () => {
    await runtime.stop('instance-0', 'host_shutdown');
    await rm(rootDir, { recursive: true, force: true });
  });
  const input = {
    pluginInstanceId: 'instance-0',
    packageRecord,
    effectiveGrants: [],
    method: 'inspect',
    params: {},
    assertCurrent: async () => {},
  };
  return { runtime, input, start: () => runtime.start('instance-0', packageRecord, []), count: () => resolutions };
}

test('settings absence avoids package resolution only for the current loaded generation', async (t) => {
  for (const materialized of [true, false])
    await t.test(materialized ? 'materializer' : 'locator', async (t) => {
      const f = await settingsProbeFixture(t, { materialized });
      await f.start();
      const before = f.count();
      let fences = 0;
      const { withOwnerOperationInvocation } = await import(
        '../dist/domains/plugin/carrier/plugin-owner-operation-context.js'
      );
      const result = await withOwnerOperationInvocation(
        {
          pluginId: f.input.packageRecord.pluginId,
          operationKey: 'inspect',
          actionId: 'inspect',
          userId: 'verified-owner',
          requestId: 'request',
          signal: new AbortController().signal,
          assertCurrent() {},
          bindActivation() {},
        },
        'instance-0',
        'inspect',
        async () => {},
        async () => {
          assert.deepEqual(
            await f.runtime.invokeSettings({
              ...f.input,
              assertCurrent: async () => {
                fences++;
              },
            }),
            { handled: false },
          );
          return f.runtime.invoke('instance-0', 'inspect', {});
        },
      );
      assert.equal(result, 'verified-owner', 'negative probe must not consume the one-shot owner invocation');
      assert.equal(f.count(), before, 'current no-settings definition must not resolve or rematerialize');
      assert.equal(fences, 1);
      await assert.rejects(
        f.runtime.invokeSettings({
          ...f.input,
          assertCurrent: async () => {
            throw Error('revoked');
          },
        }),
        /revoked/,
      );
      await assert.rejects(f.runtime.invokeSettings({ ...f.input, method: 'forged' }), /not declared/);
    });
});

test('settings probes retain verified materialization outside a current negative fact', async (t) => {
  for (const mode of ['settings-hook', 'unloaded', 'disabled', 'digest-changed', 'startup-failed'])
    await t.test(mode, async (t) => {
      const f = await settingsProbeFixture(t, { hook: mode === 'settings-hook', failStart: mode === 'startup-failed' });
      if (mode === 'startup-failed') await assert.rejects(f.start(), /startup failed/);
      else if (mode !== 'unloaded') await f.start();
      if (mode === 'disabled') await f.runtime.stop('instance-0', 'owner_disabled');
      const before = f.count();
      const result = await f.runtime.invokeSettings(
        mode === 'digest-changed'
          ? { ...f.input, packageRecord: { ...f.input.packageRecord, packageDigest: 'replacement-digest' } }
          : f.input,
      );
      assert.equal(f.count(), before + 1);
      assert.deepEqual(result, mode === 'settings-hook' ? { handled: true, result: 'settings' } : { handled: false });
    });
});

test('settings negative fact rejects stop, replacement and same-digest restart across the awaited fence', async (t) => {
  for (const mode of ['stop', 'replace', 'same-digest-restart'])
    await t.test(mode, async (t) => {
      const f = await settingsProbeFixture(t);
      await f.start();
      let entered;
      const captured = new Promise((resolve) => {
        entered = resolve;
      });
      let resume;
      const waiting = new Promise((resolve) => {
        resume = resolve;
      });
      const pending = f.runtime.invokeSettings({
        ...f.input,
        assertCurrent: async () => {
          entered();
          await waiting;
        },
      });
      const rejected = assert.rejects(
        pending,
        (error) => error.code === 'DELIVERY_REJECTED' && /activation.*changed/i.test(error.message),
      );
      await captured;
      await f.runtime.stop('instance-0', 'owner_disabled');
      if (mode !== 'stop')
        await f.runtime.start(
          'instance-0',
          mode === 'replace'
            ? { ...f.input.packageRecord, packageDigest: 'replacement-digest' }
            : f.input.packageRecord,
          [],
        );
      resume();
      await rejected;
    });
});
