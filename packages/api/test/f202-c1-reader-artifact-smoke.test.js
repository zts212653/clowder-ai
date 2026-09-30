import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { validateEffectiveGrants, validateManifest } from '@clowder-ai/plugin-contract';
import {
  readCapabilitiesConfig,
  withCapabilityLock,
  writeCapabilitiesConfig,
} from '../dist/config/capabilities/capability-orchestrator.js';
import { MessageStore } from '../dist/domains/cats/services/stores/ports/MessageStore.js';
import { LimbRegistry } from '../dist/domains/limb/LimbRegistry.js';
import {
  createDormantPluginRuntimeComposition,
  createPluginManagerRuntimeComposition,
} from '../dist/domains/plugin/index.js';
import { InstalledPluginOperations } from '../dist/domains/plugin/operations/plugin-operation-routes.js';
import { MemoryMeetingIntakeStore, MemorySignalRouteStore } from '../dist/domains/signal-intake/index.js';

test(
  'the approved reader archive activates its own limb and operations in an isolated Host',
  { skip: !process.env.F202_READER_ARCHIVE },
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'f202-reader-smoke-'));
    try {
      const records = new Map();
      const redis = {
        async hget(hash, key) {
          return records.get(hash)?.get(key) ?? null;
        },
        async hgetall(hash) {
          return Object.fromEntries(records.get(hash) ?? []);
        },
        async eval(script, _keys, hash, key, expected, value) {
          const fields = records.get(hash) ?? new Map();
          const previous = fields.get(key);
          if (script.includes('plugin-private-storage:delete-v1')) {
            if (!previous || (expected !== '*' && !previous.startsWith(`${expected}:v:`))) return 0;
            const revision = Number(fields.get('') ?? 0) + 1;
            fields.set('', String(revision));
            fields.delete(key);
            records.set(hash, fields);
            return revision;
          }
          if (expected !== '*' && (previous?.split(':v:')[0] ?? '') !== expected) return 0;
          const revision = Number(fields.get('') ?? 0) + 1;
          fields.set('', String(revision));
          fields.set(key, `${revision}:v:${value}`);
          records.set(hash, fields);
          return revision;
        },
      };
      const limbRegistry = new LimbRegistry();
      const runtime = createDormantPluginRuntimeComposition({
        projectRoot: root,
        redis,
        routes: new MemorySignalRouteStore(),
        intakes: new MemoryMeetingIntakeStore(),
        messageStore: new MessageStore(),
        contract: { manifestContractVersions: ['0.1.0'], validateEffectiveGrants, validateManifest },
        limbRegistry,
        mcpConfigIO: {
          readConfig: () => readCapabilitiesConfig(root),
          writeAndRegenCli: (config) => writeCapabilitiesConfig(root, config),
          withLock: (fn) => withCapabilityLock(root, fn),
        },
      });
      const composition = createPluginManagerRuntimeComposition({
        runtime,
        catalogProvider: { snapshot: async () => ({ entries: [], status: 'fresh', checkedAt: 1 }) },
        catalogManifests: [],
        localGrantPolicy: () => ['plugin.state.get', 'plugin.state.set'],
      });
      const installed = await composition.manager.install({
        source: { kind: 'local-archive', path: process.env.F202_READER_ARCHIVE },
      });
      const before = (await composition.manager.get(installed.pluginId)).plugin;
      const inventory = await runtime.inventoryStore.snapshot();
      console.log('INSTALLED', installed.pluginId, inventory.packages[0].provenance);
      assert.equal(inventory.packages[0].provenance.dependencyClosure, 'shipped');
      await composition.manager.setEnabled(installed.pluginId, {
        enabled: true,
        expectedRevision: before.lifecycleRevision,
      });
      assert.deepEqual(
        limbRegistry.listAvailable().map((entry) => entry.nodeId),
        ['wechat-visible-reader-mac'],
      );
      const node = limbRegistry.getNode('wechat-visible-reader-mac');
      assert.ok(node, 'package limb must be registered');
      assert.deepEqual(Object.keys(node.commandSchemas).sort(), [
        'wechat_visible_reader.read_conversation_recent',
        'wechat_visible_reader.read_visible_conversation',
      ]);
      console.log('COMMANDS', Object.keys(node.commandSchemas));
      const invocation = {
        catId: 'cat-test',
        invocationId: 'inv-test',
        userId: 'user-test',
        threadId: 'thread-test',
        userMessageId: 'message-test',
      };
      const result = await limbRegistry.invoke(
        'wechat-visible-reader-mac',
        'wechat_visible_reader.read_conversation_recent',
        { contact: '', limit: 1, acknowledgeUiNavigation: true, acknowledgeMayMarkRead: true },
        invocation,
      );
      console.log('LIMB_RESULT', JSON.stringify(result));
      assert.equal(result.data.error.code, 'navigation_failed');
      const operations = new InstalledPluginOperations({
        inventory: runtime.inventoryStore,
        configuration: composition.configuration,
        invocation: { invoke: (instanceId, method, input) => runtime.supervisor.invoke(instanceId, method, input) },
      });
      const status = await operations.runAction(installed.pluginId, 'visibleReadingAuthorization', 'status');
      assert.equal(status.body.data.armed, false);
      const armed = await operations.runAction(installed.pluginId, 'visibleReadingAuthorization', 'arm');
      assert.equal(armed.body.data.armed, true);
      const revoked = await operations.runAction(installed.pluginId, 'visibleReadingAuthorization', 'disarm');
      assert.equal(revoked.body.data.armed, false);
      console.log('OPERATIONS', JSON.stringify([status.body, armed.body, revoked.body]));
      const enabled = (await composition.manager.get(installed.pluginId)).plugin;
      await composition.manager.setEnabled(installed.pluginId, {
        enabled: false,
        expectedRevision: enabled.lifecycleRevision,
      });
      assert.equal(limbRegistry.getNode('wechat-visible-reader-mac'), undefined);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
