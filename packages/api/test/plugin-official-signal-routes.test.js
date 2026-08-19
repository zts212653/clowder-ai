import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ensureOfficialPluginSignalRoutes } from '../dist/domains/plugin/index.js';
import { MemorySignalRouteStore } from '../dist/domains/signal-intake/index.js';

const PLUGIN_ID = 'official.feishu-meeting-intake';
const SIGNAL_TYPE = 'feishu.meeting_artifact.generated.v1';

test('provisions the Host-owned route required by the official Feishu plugin', async () => {
  const routes = new MemorySignalRouteStore();

  const result = await ensureOfficialPluginSignalRoutes({
    routes,
    ownerId: 'default-user',
    now: () => 1_234,
  });

  assert.deepEqual(result, { created: 1, preserved: 0 });
  assert.deepEqual(await routes.get(PLUGIN_ID, SIGNAL_TYPE), {
    routeId: 'official:feishu-meeting-intake:meeting-intake',
    ownerId: 'default-user',
    pluginId: PLUGIN_ID,
    signalType: SIGNAL_TYPE,
    generation: 1,
    state: 'active',
    workflowKind: 'meeting-intake',
    initialUnresolved: ['speakers', 'context', 'destination', 'outputs'],
    updatedAt: 1_234,
  });
});

test('preserves an existing Host route instead of reopening or rewriting it at startup', async () => {
  const routes = new MemorySignalRouteStore();
  const existing = {
    routeId: 'operator-owned-route',
    ownerId: 'default-user',
    pluginId: PLUGIN_ID,
    signalType: SIGNAL_TYPE,
    generation: 7,
    state: 'suspended',
    workflowKind: 'meeting-intake',
    initialUnresolved: ['destination'],
    updatedAt: 900,
  };
  await routes.put(existing);

  const result = await ensureOfficialPluginSignalRoutes({
    routes,
    ownerId: 'default-user',
    now: () => 9_999,
  });

  assert.deepEqual(result, { created: 0, preserved: 1 });
  assert.deepEqual(await routes.get(PLUGIN_ID, SIGNAL_TYPE), existing);
});

test('fails closed instead of routing official artifacts to a stale private owner', async () => {
  const routes = new MemorySignalRouteStore();
  const stale = {
    routeId: 'official:feishu-meeting-intake:meeting-intake',
    ownerId: 'former-owner',
    pluginId: PLUGIN_ID,
    signalType: SIGNAL_TYPE,
    generation: 4,
    state: 'active',
    workflowKind: 'meeting-intake',
    initialUnresolved: ['speakers', 'context', 'destination', 'outputs'],
    updatedAt: 900,
  };
  await routes.put(stale);

  await assert.rejects(
    ensureOfficialPluginSignalRoutes({
      routes,
      ownerId: 'default-user',
      now: () => 9_999,
    }),
    /official signal route owner identity is corrupt/,
  );
  assert.deepEqual(await routes.get(PLUGIN_ID, SIGNAL_TYPE), stale);
});
