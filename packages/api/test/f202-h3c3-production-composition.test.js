import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { test } from 'node:test';
import { configEventBus } from '../dist/config/config-event-bus.js';
import { MessageStore } from '../dist/domains/cats/services/stores/ports/MessageStore.js';
import { CloudConversationHostRegistry } from '../dist/domains/plugin/declared/cloud-conversation-host-registry.js';
import {
  createDormantPluginRuntimeComposition,
  createPluginManagerRuntimeComposition,
} from '../dist/domains/plugin/index.js';
import { resolveLocalPluginEffectiveGrants } from '../dist/domains/plugin/manager/machine-catalog-provider.js';
import { OFFICIAL_PLUGIN_HOST_POLICIES } from '../dist/domains/plugin/manager/official-plugin-host-policies.js';
import { MemoryMeetingIntakeStore, MemorySignalRouteStore } from '../dist/domains/signal-intake/index.js';
import { ARCHIVE } from './helpers/f202-companion-artifact.js';
import { catConfig, manualScheduler } from './helpers/f202-return-poller-harness.js';

test(
  'production cloud composition shares runtime, adapter, poller and cat-config reconciliation',
  {
    skip: !ARCHIVE && process.env.F202_ARTIFACT_GATE_REQUIRED !== '1',
    timeout: 30000,
  },
  async (t) => {
    const { createCloudConversationComposition } = await import(
      '../dist/domains/cats/services/cloud-bridge/plugin-conversation-host/cloud-conversation-composition.js'
    );
    const projectRoot = await mkdtemp('/tmp/f202-h3c3-production-');
    const cats = catConfig({});
    const scheduler = manualScheduler();
    let nextCats = {};
    let reconciled = 0;
    const cloud = createCloudConversationComposition({
      cats,
      scheduler,
      ingestService: {
        ingest: async () => {
          throw new Error('no return expected');
        },
      },
      grantPersistence: 'ephemeral',
      logger: { info() {}, warn() {} },
      catalogLog: { info() {}, warn() {} },
      async reconcileCats() {
        reconciled += 1;
        cats.set(nextCats);
      },
    });
    const runtime = cloud.createRuntime({
      projectRoot,
      routes: new MemorySignalRouteStore(),
      intakes: new MemoryMeetingIntakeStore(),
      messageStore: new MessageStore(),
    });
    t.after(async () => {
      cloud.stop();
      await runtime.shutdown();
      await rm(projectRoot, { recursive: true, force: true });
    });
    cloud.start();
    const { manager } = createPluginManagerRuntimeComposition({
      runtime,
      catalogProvider: { snapshot: async () => ({ entries: [], status: 'fresh', checkedAt: 1 }) },
      catalogManifests: [],
      localGrantPolicy: (manifest) => resolveLocalPluginEffectiveGrants(OFFICIAL_PLUGIN_HOST_POLICIES, manifest),
    });
    const installed = await manager.install({ source: { kind: 'local-archive', path: ARCHIVE } });
    const detail = (await manager.get(installed.pluginId)).plugin;
    await manager.setEnabled(installed.pluginId, { enabled: true, expectedRevision: detail.lifecycleRevision });
    // A registered package reaches adapter input validation; a split registry reports HOST_UNAVAILABLE instead.
    await assert.rejects(cloud.adapter.append_message('', '', ''), { code: 'INVALID_REQUEST' });
    assert.deepEqual(scheduler.pending(), [], 'zero cats leaves no timer');
    const change = async () =>
      configEventBus.emitChangeAsync({
        source: 'cat-config',
        scope: 'file',
        changedKeys: [],
        changeSetId: 'production-test',
        timestamp: 1,
      });
    nextCats = { 'gpt-pro': { provider: 'openai-chatgpt-pro' } };
    await change();
    assert.equal(reconciled, 1);
    assert.equal(scheduler.pending().length, 1, 'same lease starts polling after registry reconciliation');
    nextCats = {};
    await change();
    assert.deepEqual(scheduler.pending(), [], 'configuration loss cancels the same lease timer');
    nextCats = { 'gpt-pro': { provider: 'openai-chatgpt-pro' } };
    await change();
    assert.equal(scheduler.pending().length, 1);
    const enabled = (await manager.get(installed.pluginId)).plugin;
    await manager.setEnabled(installed.pluginId, { enabled: false, expectedRevision: enabled.lifecycleRevision });
    assert.deepEqual(scheduler.pending(), [], 'runtime disable reaches the same poller registry');
    await assert.rejects(cloud.adapter.append_message('', '', ''), { code: 'HOST_UNAVAILABLE' });
    cloud.stop();
    await change();
    assert.equal(reconciled, 3, 'shutdown unsubscribes the production cat-catalog callback');
  },
);

test(
  'production composition registers the installed companion in the shared cloud registry',
  {
    skip: !ARCHIVE && process.env.F202_ARTIFACT_GATE_REQUIRED !== '1',
    timeout: 30000,
  },
  async (t) => {
    assert.ok(ARCHIVE);
    const projectRoot = await mkdtemp('/tmp/f202-h3c3-composition-');
    const registry = new CloudConversationHostRegistry();
    const runtime = createDormantPluginRuntimeComposition({
      projectRoot,
      cloudConversationHosts: registry,
      routes: new MemorySignalRouteStore(),
      intakes: new MemoryMeetingIntakeStore(),
      messageStore: new MessageStore(),
    });
    t.after(async () => {
      await runtime.shutdown();
      await rm(projectRoot, { recursive: true, force: true });
    });
    const { manager } = createPluginManagerRuntimeComposition({
      runtime,
      catalogProvider: { snapshot: async () => ({ entries: [], status: 'fresh', checkedAt: 1 }) },
      catalogManifests: [],
      localGrantPolicy: (manifest) => resolveLocalPluginEffectiveGrants(OFFICIAL_PLUGIN_HOST_POLICIES, manifest),
    });
    const installed = await manager.install({ source: { kind: 'local-archive', path: ARCHIVE } });
    const detail = (await manager.get(installed.pluginId)).plugin;
    const authorization = detail.configFields.find((field) => field.key === 'personalChromeAuthorizations');
    assert.equal(
      authorization.actions.find((action) => action.id === 'list').resultRender,
      'rows',
      'the real package must select the Host row renderer, otherwise Settings has no authorization controls',
    );
    await manager.setEnabled(installed.pluginId, { enabled: true, expectedRevision: detail.lifecycleRevision });
    assert.equal(registry.current('chatgpt')?.pluginId, 'official.companion.personal-chrome');
    await runtime.shutdown();
    assert.equal(registry.current('chatgpt'), undefined);
  },
);
