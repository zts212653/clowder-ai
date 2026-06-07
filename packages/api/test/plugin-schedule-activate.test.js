// @ts-check
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  PluginResourceActivator,
  rehydrateEnabledPluginSchedules,
} from '../dist/domains/plugin/PluginResourceActivator.js';
import { ScheduleFactoryRegistry } from '../dist/domains/plugin/ScheduleFactoryRegistry.js';

// ─── Test helpers ──────────────────────────────────────────────────

function makeMinimalManifest(overrides = {}) {
  return {
    id: 'test-plugin',
    name: 'Test Plugin',
    version: '1.0.0',
    builtin: false,
    config: [],
    resources: [],
    ...overrides,
  };
}

function makeScheduleResource(overrides = {}) {
  return {
    type: 'schedule',
    factoryId: 'test.poller',
    name: 'my-poller',
    ...overrides,
  };
}

function makeCapabilitiesStore() {
  /** @type {import('@cat-cafe/shared').CapabilitiesConfig | null} */
  let config = null;
  return {
    get() {
      return config;
    },
    async read() {
      return config;
    },
    async write(/** @type {import('@cat-cafe/shared').CapabilitiesConfig} */ c) {
      config = structuredClone(c);
    },
  };
}

function makeTaskRunner() {
  /** @type {Array<{id: string}>} */
  const registered = [];
  /** @type {string[]} */
  const unregistered = [];
  /** @type {Set<string>} — tracks currently-live task IDs for realistic unregister */
  const live = new Set();
  return {
    registered,
    unregistered,
    registerPostStart(/** @type {any} */ task) {
      if (live.has(task.id)) {
        throw new Error(`TaskRunnerV2: duplicate task id "${task.id}"`);
      }
      registered.push(task);
      live.add(task.id);
    },
    unregister(/** @type {string} */ taskId) {
      if (!live.has(taskId)) return false;
      live.delete(taskId);
      unregistered.push(taskId);
      return true;
    },
    register(/** @type {any} */ task) {
      registered.push(task);
      live.add(task.id);
    },
  };
}

function makeStubFactory(factoryId = 'test.poller', pluginId = 'test-plugin') {
  return {
    pluginId,
    factoryId,
    createTaskSpec(/** @type {string} */ instanceId, /** @type {any} */ _deps) {
      return /** @type {any} */ ({
        id: instanceId,
        profile: 'poller',
        trigger: { type: 'interval', ms: 60_000 },
        admission: { gate: async () => ({ run: false, reason: 'stub' }) },
        run: { overlap: 'skip', timeoutMs: 30_000, execute: async () => {} },
        state: { runLedger: 'sqlite' },
        outcome: { whenNoSignal: 'drop' },
        enabled: () => true,
      });
    },
  };
}

function makeLimbRegistry() {
  return { register: async () => {}, deregister: () => {} };
}

function makeActivator(deps = {}) {
  const capStore = deps.capStore ?? makeCapabilitiesStore();
  const taskRunner = deps.taskRunner ?? makeTaskRunner();
  const scheduleFactoryRegistry = deps.scheduleFactoryRegistry ?? new ScheduleFactoryRegistry();
  const scheduleFactoryDeps = { log: { info: () => {}, error: () => {}, warn: () => {} } };

  const activator = new PluginResourceActivator({
    resolveProjectRoot: () => '/tmp/project',
    pluginsDir: '/tmp/plugins',
    limbRegistry: makeLimbRegistry(),
    readCapabilities: () => capStore.read(),
    writeCapabilities: (c) => capStore.write(c),
    withCapabilityLock: async (fn) => fn(),
    scheduleFactoryRegistry,
    taskRunner,
    scheduleFactoryDeps,
    ...deps,
  });

  return { activator, capStore, taskRunner, scheduleFactoryRegistry };
}

// ─── Tests ─────────────────────────────────────────────────────────

describe('PluginResourceActivator — schedule resources', () => {
  it('activateSchedule registers task in TaskRunner + writes capability entry', async () => {
    const registry = new ScheduleFactoryRegistry();
    registry.register(makeStubFactory('test.poller'));
    const { activator, capStore, taskRunner } = makeActivator({ scheduleFactoryRegistry: registry });

    const manifest = makeMinimalManifest({
      resources: [makeScheduleResource()],
    });
    const result = await activator.enablePlugin(manifest);

    assert.strictEqual(result.status, 'success');
    assert.strictEqual(result.resources.length, 1);
    assert.strictEqual(result.resources[0].ok, true);

    // TaskRunner should have received the task
    assert.strictEqual(taskRunner.registered.length, 1);
    assert.strictEqual(taskRunner.registered[0].id, 'schedule:test-plugin:my-poller');

    // Capability entry should be written
    const config = capStore.get();
    assert.ok(config);
    const entry = config.capabilities.find((c) => c.type === 'schedule');
    assert.ok(entry);
    assert.strictEqual(entry.enabled, true);
    assert.strictEqual(entry.pluginId, 'test-plugin');
    assert.strictEqual(entry.scheduleTaskId, 'schedule:test-plugin:my-poller');
  });

  it('deactivateSchedule unregisters task + removes capability entry', async () => {
    const registry = new ScheduleFactoryRegistry();
    registry.register(makeStubFactory('test.poller'));
    const { activator, capStore, taskRunner } = makeActivator({ scheduleFactoryRegistry: registry });

    const manifest = makeMinimalManifest({
      resources: [makeScheduleResource()],
    });

    // First enable
    await activator.enablePlugin(manifest);
    assert.strictEqual(taskRunner.registered.length, 1);

    // Then disable
    const result = await activator.disablePlugin(manifest);
    assert.strictEqual(result.status, 'success');

    // TaskRunner.unregister should have been called
    assert.strictEqual(taskRunner.unregistered.length, 1);
    assert.strictEqual(taskRunner.unregistered[0], 'schedule:test-plugin:my-poller');

    // Capability entry should be removed
    const config = capStore.get();
    assert.ok(config);
    const scheduleEntries = config.capabilities.filter((c) => c.type === 'schedule');
    assert.strictEqual(scheduleEntries.length, 0);
  });

  it('P2-cloud-8: deactivateSchedule unregisters fallback task ID when legacy capability lacks scheduleTaskId', async () => {
    const registry = new ScheduleFactoryRegistry();
    registry.register(makeStubFactory('test.poller'));
    const capStore = makeCapabilitiesStore();
    const taskRunner = makeTaskRunner();
    const { activator } = makeActivator({ scheduleFactoryRegistry: registry, capStore, taskRunner });

    await capStore.write({
      version: 1,
      capabilities: [
        {
          id: 'plugin:test-plugin:my-poller',
          type: 'schedule',
          enabled: true,
          source: 'cat-cafe',
          pluginId: 'test-plugin',
        },
      ],
    });
    taskRunner.register(makeStubFactory('test.poller').createTaskSpec('schedule:test-plugin:my-poller', {}));

    const manifest = makeMinimalManifest({ resources: [makeScheduleResource()] });
    const result = await activator.disablePlugin(manifest);

    assert.strictEqual(result.status, 'success');
    assert.ok(
      taskRunner.unregistered.includes('schedule:test-plugin:my-poller'),
      'legacy schedule capability without scheduleTaskId must unregister fallback task ID',
    );
    assert.strictEqual(capStore.get()?.capabilities.length, 0);
  });

  it('activateSchedule throws when factoryId not found in registry', async () => {
    // Empty registry — no factories registered
    const { activator } = makeActivator();

    const manifest = makeMinimalManifest({
      resources: [makeScheduleResource({ factoryId: 'nonexistent.factory' })],
    });
    const result = await activator.enablePlugin(manifest);

    assert.strictEqual(result.status, 'failed');
    assert.strictEqual(result.resources[0].ok, false);
    assert.ok(result.resources[0].error?.includes('nonexistent.factory'));
  });

  it('P2-cloud-7: activateSchedule rejects factories owned by another plugin', async () => {
    const registry = new ScheduleFactoryRegistry();
    registry.register(makeStubFactory('github.review-feedback', 'github'));
    const { activator, taskRunner } = makeActivator({ scheduleFactoryRegistry: registry });

    const manifest = makeMinimalManifest({
      id: 'other-plugin',
      resources: [makeScheduleResource({ factoryId: 'github.review-feedback', name: 'review-feedback' })],
    });

    const result = await activator.enablePlugin(manifest);
    const scheduleResult = result.resources.find((r) => r.type === 'schedule');

    assert.strictEqual(scheduleResult?.ok, false, 'cross-plugin factory reference must fail');
    assert.match(scheduleResult?.error ?? '', /not owned by plugin 'other-plugin'/);
    assert.strictEqual(taskRunner.registered.length, 0, 'foreign factory must not register a task');
  });

  it('activateSchedule throws when factoryId is missing', async () => {
    const { activator } = makeActivator();

    const manifest = makeMinimalManifest({
      resources: [makeScheduleResource({ factoryId: undefined })],
    });
    const result = await activator.enablePlugin(manifest);

    assert.strictEqual(result.status, 'failed');
    assert.strictEqual(result.resources[0].ok, false);
    assert.ok(result.resources[0].error?.includes('factoryId'));
  });

  it('activateSchedule throws when name is missing', async () => {
    const registry = new ScheduleFactoryRegistry();
    registry.register(makeStubFactory('test.poller'));
    const { activator } = makeActivator({ scheduleFactoryRegistry: registry });

    const manifest = makeMinimalManifest({
      resources: [makeScheduleResource({ name: undefined })],
    });
    const result = await activator.enablePlugin(manifest);

    assert.strictEqual(result.status, 'failed');
    assert.strictEqual(result.resources[0].ok, false);
    assert.ok(result.resources[0].error?.includes('name'));
  });

  it('activate then deactivate → task not running, capability gone', async () => {
    const registry = new ScheduleFactoryRegistry();
    registry.register(makeStubFactory('test.poller'));
    const { activator, capStore, taskRunner } = makeActivator({ scheduleFactoryRegistry: registry });

    const manifest = makeMinimalManifest({
      resources: [makeScheduleResource()],
    });

    // Full lifecycle
    await activator.enablePlugin(manifest);
    const configAfterEnable = capStore.get();
    assert.strictEqual(configAfterEnable?.capabilities.length, 1);

    await activator.disablePlugin(manifest);
    const configAfterDisable = capStore.get();
    assert.strictEqual(configAfterDisable?.capabilities.length, 0);

    // Both register and unregister were called
    assert.strictEqual(taskRunner.registered.length, 1);
    assert.strictEqual(taskRunner.unregistered.length, 1);
  });

  it('handles multiple schedule resources in one plugin', async () => {
    const registry = new ScheduleFactoryRegistry();
    registry.register(makeStubFactory('test.poller'));
    registry.register(makeStubFactory('test.checker'));
    const { activator, capStore, taskRunner } = makeActivator({ scheduleFactoryRegistry: registry });

    const manifest = makeMinimalManifest({
      resources: [
        makeScheduleResource({ factoryId: 'test.poller', name: 'poller' }),
        makeScheduleResource({ factoryId: 'test.checker', name: 'checker' }),
      ],
    });

    const result = await activator.enablePlugin(manifest);
    assert.strictEqual(result.status, 'success');
    assert.strictEqual(taskRunner.registered.length, 2);
    assert.strictEqual(capStore.get()?.capabilities.length, 2);
  });

  // ─── P1 regression tests (review round 1) ─────────────────────────

  it('P1-1: activateSchedule uses registerPostStart, not registerDynamic', async () => {
    const registry = new ScheduleFactoryRegistry();
    registry.register(makeStubFactory('test.poller'));
    const taskRunner = makeTaskRunner();
    // Track which method was called
    let postStartCalled = false;
    let dynamicCalled = false;
    taskRunner.registerPostStart = (task) => {
      postStartCalled = true;
      taskRunner.registered.push(task);
    };
    taskRunner.registerDynamic = (task, _defId) => {
      dynamicCalled = true;
      taskRunner.registered.push(task);
    };
    const { activator } = makeActivator({ scheduleFactoryRegistry: registry, taskRunner });

    const manifest = makeMinimalManifest({ resources: [makeScheduleResource()] });
    await activator.enablePlugin(manifest);

    assert.strictEqual(postStartCalled, true, 'registerPostStart must be called');
    assert.strictEqual(dynamicCalled, false, 'registerDynamic must NOT be called');
  });

  it('P1-2: activateSchedule rolls back task registration on capability write failure', async () => {
    const registry = new ScheduleFactoryRegistry();
    registry.register(makeStubFactory('test.poller'));
    const taskRunner = makeTaskRunner();

    // Capability store that fails on write
    let writeCount = 0;
    const capStore = makeCapabilitiesStore();
    const failingCapStore = {
      get: () => capStore.get(),
      read: () => capStore.read(),
      write: async (c) => {
        writeCount++;
        throw new Error('disk full');
      },
    };

    const { activator } = makeActivator({
      scheduleFactoryRegistry: registry,
      taskRunner,
      capStore: failingCapStore,
    });

    const manifest = makeMinimalManifest({ resources: [makeScheduleResource()] });
    const result = await activator.enablePlugin(manifest);

    assert.strictEqual(result.status, 'failed');
    // Task was registered then must have been unregistered (rollback)
    assert.strictEqual(taskRunner.unregistered.length, 1, 'task must be unregistered on capability write failure');
    assert.strictEqual(taskRunner.unregistered[0], 'schedule:test-plugin:my-poller');
  });

  it('P1-3: removeOrphanedPluginEntries unregisters orphaned schedule tasks', async () => {
    const registry = new ScheduleFactoryRegistry();
    registry.register(makeStubFactory('test.poller'));
    const { activator, capStore, taskRunner } = makeActivator({ scheduleFactoryRegistry: registry });

    // Step 1: enable plugin with a schedule resource
    const manifest = makeMinimalManifest({
      resources: [makeScheduleResource({ factoryId: 'test.poller', name: 'old-poller' })],
    });
    await activator.enablePlugin(manifest);
    assert.strictEqual(capStore.get()?.capabilities.length, 1);

    // Step 2: disable with a DIFFERENT resource list (simulates plugin.yaml change)
    // The old 'old-poller' entry is now orphaned
    const updatedManifest = makeMinimalManifest({
      resources: [makeScheduleResource({ factoryId: 'test.poller', name: 'new-poller' })],
    });
    // We need to first register a new factory call so enable works
    await activator.enablePlugin(updatedManifest);
    // Now disable the updated manifest — the old 'old-poller' is orphaned
    await activator.disablePlugin(updatedManifest);

    // Both old-poller (orphan cleanup) and new-poller (deactivate) should be unregistered
    assert.ok(
      taskRunner.unregistered.includes('schedule:test-plugin:old-poller'),
      'orphaned schedule task must be unregistered',
    );
    assert.ok(
      taskRunner.unregistered.includes('schedule:test-plugin:new-poller'),
      'current schedule task must be unregistered via deactivateSchedule',
    );
  });

  it('P2-cloud-8: orphan cleanup unregisters fallback task ID when legacy capability lacks scheduleTaskId', async () => {
    const registry = new ScheduleFactoryRegistry();
    registry.register(makeStubFactory('test.poller'));
    const capStore = makeCapabilitiesStore();
    const taskRunner = makeTaskRunner();
    const { activator } = makeActivator({ scheduleFactoryRegistry: registry, capStore, taskRunner });

    await capStore.write({
      version: 1,
      capabilities: [
        {
          id: 'plugin:test-plugin:old-poller',
          type: 'schedule',
          enabled: true,
          source: 'cat-cafe',
          pluginId: 'test-plugin',
        },
      ],
    });
    taskRunner.register(makeStubFactory('test.poller').createTaskSpec('schedule:test-plugin:old-poller', {}));

    const updatedManifest = makeMinimalManifest({
      resources: [makeScheduleResource({ factoryId: 'test.poller', name: 'new-poller' })],
    });
    const result = await activator.disablePlugin(updatedManifest);

    assert.strictEqual(result.status, 'success');
    assert.ok(
      taskRunner.unregistered.includes('schedule:test-plugin:old-poller'),
      'orphaned legacy schedule capability without scheduleTaskId must unregister fallback task ID',
    );
    assert.strictEqual(capStore.get()?.capabilities.length, 0);
  });

  it('P1-R2: deactivateSchedule does not unregister task when capability removal fails', async () => {
    const registry = new ScheduleFactoryRegistry();
    registry.register(makeStubFactory('test.poller'));
    const capStore = makeCapabilitiesStore();
    const taskRunner = makeTaskRunner();
    const { activator } = makeActivator({ scheduleFactoryRegistry: registry, taskRunner, capStore });

    const manifest = makeMinimalManifest({ resources: [makeScheduleResource()] });

    // Enable normally — task registered + capability written
    await activator.enablePlugin(manifest);
    assert.strictEqual(taskRunner.registered.length, 1);
    assert.strictEqual(capStore.get()?.capabilities.length, 1);

    // Make writes fail from now on (simulates disk-full during disable)
    const originalWrite = capStore.write.bind(capStore);
    capStore.write = async () => {
      throw new Error('disk full');
    };

    // Disable should fail because capability removal can't persist
    const result = await activator.disablePlugin(manifest);
    assert.strictEqual(result.resources[0].ok, false);

    // Invariant: runtime task must NOT be unregistered when persist fails
    // (persist-first ordering — mirrors deactivateLimb pattern)
    assert.strictEqual(
      taskRunner.unregistered.length,
      0,
      'task must not be unregistered when capability removal fails',
    );

    // Capability entry must still exist (write failed → state unchanged)
    assert.strictEqual(capStore.get()?.capabilities.length, 1);
    assert.strictEqual(capStore.get()?.capabilities[0].enabled, true);
  });

  it('P2-cloud: type transition from schedule to MCP unregisters stale schedule task', async () => {
    const registry = new ScheduleFactoryRegistry();
    registry.register(makeStubFactory('test.poller'));
    const { activator, capStore, taskRunner } = makeActivator({ scheduleFactoryRegistry: registry });

    // Step 1: enable plugin with a schedule resource named 'my-poller'
    const schedManifest = makeMinimalManifest({
      resources: [makeScheduleResource({ factoryId: 'test.poller', name: 'my-poller' })],
    });
    await activator.enablePlugin(schedManifest);
    assert.strictEqual(taskRunner.registered.length, 1);
    assert.strictEqual(taskRunner.registered[0].id, 'schedule:test-plugin:my-poller');

    // Step 2: re-enable with the SAME name but type=mcp (type transition)
    const mcpManifest = makeMinimalManifest({
      resources: [
        {
          type: 'mcp',
          name: 'my-poller',
          command: 'node',
          args: ['server.js'],
        },
      ],
    });
    await activator.enablePlugin(mcpManifest);

    // The old schedule task must be unregistered (stale cleanup)
    assert.ok(
      taskRunner.unregistered.includes('schedule:test-plugin:my-poller'),
      'stale schedule task must be unregistered on type transition',
    );

    // Capability should now be MCP type
    const config = capStore.get();
    const entry = config?.capabilities.find((c) => c.pluginId === 'test-plugin');
    assert.strictEqual(entry?.type, 'mcp');
    assert.strictEqual(entry?.scheduleTaskId, undefined);
  });

  it('P2-cloud-9: type transition unregisters fallback task ID when legacy schedule lacks scheduleTaskId', async () => {
    const capStore = makeCapabilitiesStore();
    const taskRunner = makeTaskRunner();
    const { activator } = makeActivator({ capStore, taskRunner });

    await capStore.write({
      version: 1,
      capabilities: [
        {
          id: 'plugin:test-plugin:my-poller',
          type: 'schedule',
          enabled: true,
          source: 'cat-cafe',
          pluginId: 'test-plugin',
        },
      ],
    });
    taskRunner.register(makeStubFactory('test.poller').createTaskSpec('schedule:test-plugin:my-poller', {}));

    const mcpManifest = makeMinimalManifest({
      resources: [
        {
          type: 'mcp',
          name: 'my-poller',
          command: 'node',
          args: ['server.js'],
        },
      ],
    });

    const result = await activator.enablePlugin(mcpManifest);

    assert.strictEqual(result.status, 'success');
    assert.ok(
      taskRunner.unregistered.includes('schedule:test-plugin:my-poller'),
      'legacy schedule capability without scheduleTaskId must unregister fallback task ID on type transition',
    );
    const entry = capStore.get()?.capabilities.find((c) => c.pluginId === 'test-plugin');
    assert.strictEqual(entry?.type, 'mcp');
    assert.strictEqual(entry?.scheduleTaskId, undefined);
  });

  it('P2-cloud-2: schedule task IDs are unambiguous across plugins with hyphenated names', async () => {
    // Plugin "a-b" schedule "c" and plugin "a" schedule "b-c" must produce distinct taskIds.
    // With hyphen concatenation both would be "plugin-a-b-c" → collision.
    // With colon delimiter: "schedule:a-b:c" vs "schedule:a:b-c" → no collision.
    const registry = new ScheduleFactoryRegistry();
    registry.register(makeStubFactory('a-b.poller', 'a-b'));
    registry.register(makeStubFactory('a.poller', 'a'));
    const taskRunner = makeTaskRunner();
    const { activator, capStore } = makeActivator({ scheduleFactoryRegistry: registry, taskRunner });

    const manifest1 = makeMinimalManifest({
      id: 'a-b',
      resources: [{ type: 'schedule', name: 'c', factoryId: 'a-b.poller' }],
    });
    const manifest2 = makeMinimalManifest({
      id: 'a',
      resources: [{ type: 'schedule', name: 'b-c', factoryId: 'a.poller' }],
    });

    await activator.enablePlugin(manifest1);
    await activator.enablePlugin(manifest2);

    // Both must register successfully with distinct task IDs
    assert.strictEqual(taskRunner.registered.length, 2, 'both plugins should register');
    assert.notStrictEqual(
      taskRunner.registered[0].id,
      taskRunner.registered[1].id,
      'task IDs must be distinct: ' + taskRunner.registered[0].id + ' vs ' + taskRunner.registered[1].id,
    );
  });

  it('P2-cloud-3: double enable is idempotent (no duplicate task error)', async () => {
    const registry = new ScheduleFactoryRegistry();
    registry.register(makeStubFactory('test.poller'));
    const taskRunner = makeTaskRunner();
    const { activator } = makeActivator({ scheduleFactoryRegistry: registry, taskRunner });

    const manifest = makeMinimalManifest({
      resources: [{ type: 'schedule', name: 'my-poller', factoryId: 'test.poller' }],
    });

    // Enable twice — second call must not throw
    await activator.enablePlugin(manifest);
    await assert.doesNotReject(() => activator.enablePlugin(manifest), 'second enable should be idempotent');
    // The task should still be registered (latest registration wins)
    assert.ok(
      taskRunner.registered.some((t) => t.id === 'schedule:test-plugin:my-poller'),
      'task should be registered after double enable',
    );
  });

  it('P2-cloud-4: factory returning mismatched task ID is rejected', async () => {
    const registry = new ScheduleFactoryRegistry();
    // Register a factory that ignores the requested taskId and returns its own
    registry.register({
      pluginId: 'test-plugin',
      factoryId: 'bad.factory',
      createTaskSpec(_taskId, _deps) {
        return { id: 'rogue-task-id', intervalMs: 60000, handler: async () => {} };
      },
    });
    const taskRunner = makeTaskRunner();
    const { activator } = makeActivator({ scheduleFactoryRegistry: registry, taskRunner });

    const manifest = makeMinimalManifest({
      resources: [{ type: 'schedule', name: 'my-poller', factoryId: 'bad.factory' }],
    });

    // enablePlugin catches per-resource errors — check result.ok instead of rejects
    const result = await activator.enablePlugin(manifest);
    const scheduleResult = result.resources.find((r) => r.type === 'schedule');
    assert.strictEqual(scheduleResult?.ok, false, 'schedule activation should fail');
    assert.match(scheduleResult?.error ?? '', /mismatched task ID/);
    // No task should be registered (rejected before registration)
    assert.strictEqual(taskRunner.registered.length, 0, 'no task registered on mismatch');
  });

  it('P2-cloud-5: failed re-enable preserves existing task (no window of inconsistency)', async () => {
    const registry = new ScheduleFactoryRegistry();
    registry.register(makeStubFactory('test.poller'));
    const taskRunner = makeTaskRunner();
    // First enable succeeds, second enable write fails
    let writeCount = 0;
    const capStore = makeCapabilitiesStore();
    const failingWrite = async (c) => {
      writeCount++;
      if (writeCount > 1) throw new Error('disk full');
      await capStore.write(c);
    };
    const { activator } = makeActivator({
      scheduleFactoryRegistry: registry,
      taskRunner,
      capStore,
      writeCapabilities: failingWrite,
    });

    const manifest = makeMinimalManifest({
      resources: [{ type: 'schedule', name: 'my-poller', factoryId: 'test.poller' }],
    });

    // First enable succeeds
    await activator.enablePlugin(manifest);
    assert.strictEqual(taskRunner.registered.length, 1);

    // Second enable: registerPostStart throws (duplicate caught), write fails
    const result2 = await activator.enablePlugin(manifest);
    const scheduleResult = result2.resources.find((r) => r.type === 'schedule');
    assert.strictEqual(scheduleResult?.ok, false, 'second enable should report failure');

    // Existing task must still be live (not unregistered)
    assert.strictEqual(taskRunner.unregistered.length, 0, 'existing task must NOT be unregistered on failed re-enable');
  });
});

describe('rehydrateEnabledPluginSchedules', () => {
  it('rehydrates enabled schedule capabilities from config', async () => {
    const registry = new ScheduleFactoryRegistry();
    registry.register(makeStubFactory('test.poller'));
    const taskRunner = makeTaskRunner();

    /** @type {import('@cat-cafe/shared').CapabilitiesConfig} */
    const capabilities = {
      version: 1,
      capabilities: [
        {
          id: 'plugin:test-plugin:my-poller',
          type: 'schedule',
          enabled: true,
          source: 'cat-cafe',
          pluginId: 'test-plugin',
          scheduleTaskId: 'schedule:test-plugin:my-poller',
        },
      ],
    };

    const pluginRegistry = {
      getManifest(/** @type {string} */ pluginId) {
        if (pluginId === 'test-plugin') {
          return makeMinimalManifest({
            resources: [makeScheduleResource()],
          });
        }
        return undefined;
      },
    };

    await rehydrateEnabledPluginSchedules({
      capabilities,
      pluginRegistry,
      scheduleFactoryRegistry: registry,
      taskRunner,
      scheduleFactoryDeps: { log: { info: () => {}, error: () => {}, warn: () => {} } },
      log: { info: () => {}, warn: () => {} },
    });

    assert.strictEqual(taskRunner.registered.length, 1);
    assert.strictEqual(taskRunner.registered[0].id, 'schedule:test-plugin:my-poller');
  });

  it('skips disabled schedule capabilities', async () => {
    const registry = new ScheduleFactoryRegistry();
    registry.register(makeStubFactory('test.poller'));
    const taskRunner = makeTaskRunner();

    /** @type {import('@cat-cafe/shared').CapabilitiesConfig} */
    const capabilities = {
      version: 1,
      capabilities: [
        {
          id: 'plugin:test-plugin:my-poller',
          type: 'schedule',
          enabled: false, // disabled
          source: 'cat-cafe',
          pluginId: 'test-plugin',
          scheduleTaskId: 'schedule:test-plugin:my-poller',
        },
      ],
    };

    const pluginRegistry = {
      getManifest(/** @type {string} */ _id) {
        return makeMinimalManifest({ resources: [makeScheduleResource()] });
      },
    };

    await rehydrateEnabledPluginSchedules({
      capabilities,
      pluginRegistry,
      scheduleFactoryRegistry: registry,
      taskRunner,
      scheduleFactoryDeps: { log: { info: () => {}, error: () => {}, warn: () => {} } },
    });

    assert.strictEqual(taskRunner.registered.length, 0);
  });

  it('skips when factory not registered (warns)', async () => {
    const registry = new ScheduleFactoryRegistry(); // empty — no factories
    const taskRunner = makeTaskRunner();
    const warnings = [];

    /** @type {import('@cat-cafe/shared').CapabilitiesConfig} */
    const capabilities = {
      version: 1,
      capabilities: [
        {
          id: 'plugin:test-plugin:my-poller',
          type: 'schedule',
          enabled: true,
          source: 'cat-cafe',
          pluginId: 'test-plugin',
          scheduleTaskId: 'schedule:test-plugin:my-poller',
        },
      ],
    };

    const pluginRegistry = {
      getManifest(/** @type {string} */ _id) {
        return makeMinimalManifest({ resources: [makeScheduleResource()] });
      },
    };

    await rehydrateEnabledPluginSchedules({
      capabilities,
      pluginRegistry,
      scheduleFactoryRegistry: registry,
      taskRunner,
      scheduleFactoryDeps: { log: { info: () => {}, error: () => {}, warn: () => {} } },
      log: { info: () => {}, warn: (...args) => warnings.push(args.join(' ')) },
    });

    assert.strictEqual(taskRunner.registered.length, 0);
    assert.ok(warnings.some((w) => w.includes('test.poller')));
  });

  it('handles null capabilities gracefully', async () => {
    const registry = new ScheduleFactoryRegistry();
    const taskRunner = makeTaskRunner();

    await rehydrateEnabledPluginSchedules({
      capabilities: null,
      pluginRegistry: { getManifest: () => undefined },
      scheduleFactoryRegistry: registry,
      taskRunner,
      scheduleFactoryDeps: { log: { info: () => {}, error: () => {}, warn: () => {} } },
    });

    assert.strictEqual(taskRunner.registered.length, 0);
  });

  it('P2-cloud-6: rehydration rejects factory returning mismatched task ID', async () => {
    const registry = new ScheduleFactoryRegistry();
    // Factory that returns a rogue task ID
    registry.register({
      pluginId: 'test-plugin',
      factoryId: 'test.poller',
      createTaskSpec(_taskId, _deps) {
        return { id: 'rogue-id', intervalMs: 60000, handler: async () => {} };
      },
    });
    const taskRunner = makeTaskRunner();
    const warnings = [];

    /** @type {import('@cat-cafe/shared').CapabilitiesConfig} */
    const capabilities = {
      version: 1,
      capabilities: [
        {
          id: 'plugin:test-plugin:my-poller',
          type: 'schedule',
          enabled: true,
          source: 'cat-cafe',
          pluginId: 'test-plugin',
          scheduleTaskId: 'schedule:test-plugin:my-poller',
        },
      ],
    };

    const pluginRegistry = {
      getManifest(/** @type {string} */ _id) {
        return makeMinimalManifest({ resources: [makeScheduleResource()] });
      },
    };

    await rehydrateEnabledPluginSchedules({
      capabilities,
      pluginRegistry,
      scheduleFactoryRegistry: registry,
      taskRunner,
      scheduleFactoryDeps: { log: { info: () => {}, error: () => {}, warn: () => {} } },
      log: { info: () => {}, warn: (...args) => warnings.push(args.join(' ')) },
    });

    // Task must NOT be registered (factory returned wrong ID)
    assert.strictEqual(taskRunner.registered.length, 0, 'rogue task must not be registered');
    // Warning must mention mismatch
    assert.ok(
      warnings.some((w) => w.includes('mismatched')),
      'should warn about mismatched task ID',
    );
  });

  it('P2-cloud-7: rehydration skips factories owned by another plugin', async () => {
    const registry = new ScheduleFactoryRegistry();
    registry.register(makeStubFactory('github.review-feedback', 'github'));
    const taskRunner = makeTaskRunner();
    const warnings = [];

    /** @type {import('@cat-cafe/shared').CapabilitiesConfig} */
    const capabilities = {
      version: 1,
      capabilities: [
        {
          id: 'plugin:other-plugin:review-feedback',
          type: 'schedule',
          enabled: true,
          source: 'cat-cafe',
          pluginId: 'other-plugin',
          scheduleTaskId: 'schedule:other-plugin:review-feedback',
        },
      ],
    };

    const pluginRegistry = {
      getManifest(/** @type {string} */ pluginId) {
        if (pluginId !== 'other-plugin') return undefined;
        return makeMinimalManifest({
          id: 'other-plugin',
          resources: [makeScheduleResource({ factoryId: 'github.review-feedback', name: 'review-feedback' })],
        });
      },
    };

    await rehydrateEnabledPluginSchedules({
      capabilities,
      pluginRegistry,
      scheduleFactoryRegistry: registry,
      taskRunner,
      scheduleFactoryDeps: { log: { info: () => {}, error: () => {}, warn: () => {} } },
      log: { info: () => {}, warn: (...args) => warnings.push(args.join(' ')) },
    });

    assert.strictEqual(taskRunner.registered.length, 0, 'foreign factory must not be rehydrated');
    assert.ok(
      warnings.some((w) => w.includes("not owned by plugin 'other-plugin'")),
      'should warn about cross-plugin factory ownership',
    );
  });
});
