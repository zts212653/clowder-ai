import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { MessageStore } from '../dist/domains/cats/services/stores/ports/MessageStore.js';
import { CollectiveConnectorBuiltinRuntime } from '../dist/domains/plugin/builtin-runtime/collective-connector-runtime.js';
import {
  COLLECTIVE_CONNECTOR_PLUGIN_MANIFEST,
  createDormantPluginRuntimeComposition,
  OFFICIAL_PLUGIN_CATALOG,
} from '../dist/domains/plugin/index.js';
import { MemoryMeetingIntakeStore, MemorySignalRouteStore } from '../dist/domains/signal-intake/index.js';

test('runtime composition registers the official Connector as a Host builtin and recovers owner intent', async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), 'collective-runtime-composition-'));
  const entry = OFFICIAL_PLUGIN_CATALOG.find((candidate) => candidate.catalogId === 'collective-connector');
  assert.ok(entry);
  const runtime = createDormantPluginRuntimeComposition({
    projectRoot,
    routes: new MemorySignalRouteStore(),
    intakes: new MemoryMeetingIntakeStore(),
    messageStore: new MessageStore(),
    collectiveConnector: {
      verifyAgent: async () => true,
      syncIntervalMs: 60_000,
    },
    now: () => 40_000,
  });
  const installed = await runtime.inventory.installPackage({
    manifest: COLLECTIVE_CONNECTOR_PLUGIN_MANIFEST,
    computedPackageDigest: entry.packageDigest,
    expectedPackageDigest: entry.packageDigest,
    packagePluginId: entry.pluginId,
    effectiveGrants: [],
    signalSchemas: {},
  });

  const prepared = await runtime.lifecycle.prepare(installed.pluginInstanceId, 1);
  const enabled = await runtime.lifecycle.enable(installed.pluginInstanceId, prepared.lifecycleRevision);
  assert.equal(enabled.runtimeState, 'healthy');
  assert.ok(runtime.collectiveConnectorRuntime?.connector(), 'enabled builtin must expose Connector control plane');

  const disabled = await runtime.lifecycle.disable(installed.pluginInstanceId, enabled.lifecycleRevision);
  assert.equal(disabled.runtimeState, 'stopped');
  assert.equal(runtime.collectiveConnectorRuntime?.connector(), undefined);
  await runtime.shutdown();
});

test('builtin runtime dispatches persisted Collective inbox after connection sync', async () => {
  const order = [];
  let resolveDispatch;
  const dispatched = new Promise((resolve) => {
    resolveDispatch = resolve;
  });
  const connector = {
    async listConnections() {
      order.push('list');
      return [{ connectionId: 'conn_runtime_dispatch', authorityStatus: 'active' }];
    },
    async sync(connectionId) {
      order.push(`sync:${connectionId}`);
    },
  };
  const runtime = new CollectiveConnectorBuiltinRuntime({
    dataDirectory: '/tmp/collective-runtime-dispatch-test',
    verifyAgent: async () => true,
    syncIntervalMs: 60_000,
    openConnector: async () => connector,
    createIngressDispatcher: () => ({
      async dispatchConnection(connectionId) {
        order.push(`dispatch:${connectionId}`);
        resolveDispatch();
      },
    }),
  });

  await runtime.start('instance_collective_runtime_dispatch');
  await Promise.race([
    dispatched,
    new Promise((_, reject) => setTimeout(() => reject(new Error('Timed out waiting for ingress dispatch')), 1_000)),
  ]);
  assert.deepEqual(order, ['list', 'sync:conn_runtime_dispatch', 'dispatch:conn_runtime_dispatch']);
  await runtime.stop('instance_collective_runtime_dispatch', 'test complete');
});
