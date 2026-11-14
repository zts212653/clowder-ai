import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { validateManifest } from '@clowder-ai/plugin-contract';

import { MessageStore } from '../dist/domains/cats/services/stores/ports/MessageStore.js';
import { ThreadStore } from '../dist/domains/cats/services/stores/ports/ThreadStore.js';
import { createPublishingMessageStore } from '../dist/domains/messaging/publishing-message-store.js';
import { createMessagingStores } from '../dist/domains/messaging/stores/factory.js';
import { SubscriptionDrainScheduler } from '../dist/domains/messaging/subscription-drain-scheduler.js';
import {
  createDormantPluginRuntimeComposition,
  createPluginManagerRuntimeComposition,
} from '../dist/domains/plugin/index.js';
import { MemoryConnectorThreadBindingStore } from '../dist/infrastructure/connectors/ConnectorThreadBindingStore.js';
import { workerObservation } from './helpers/worker-observation.js';

const roots = [];
const runtimes = [];

afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.shutdown('test_done');
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function tempRoot(label) {
  const root = await mkdtemp(join(tmpdir(), label));
  roots.push(root);
  return root;
}

async function waitFor(predicate, message, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function productionSubscriptionScenario(recovering) {
  const projectRoot = await tempRoot('cat-cafe-f202-production-subscription-project-');
  const packageRoot = await tempRoot('cat-cafe-f202-production-subscription-package-');
  const observation = workerObservation(join(projectRoot, 'subscription-observation.json'), {
    calls: [],
    lifecycleCalls: [],
    sequence: [],
  });
  const pluginId = 'dev.clowder.production-subscription-fixture';
  const manifest = {
    pluginId,
    version: '1.0.0',
    contractVersion: '0.1.0',
    name: 'Production subscription fixture',
    contributions: [
      { type: 'identity', id: 'fixture-identity', displayName: 'Fixture', icon: 'fixture' },
      {
        type: 'message-subscription',
        id: 'fixture-subscription',
        binding: 'fixture-identity',
        action: { method: 'fixture.outbound' },
        presentation: 'v1',
      },
    ],
    features: [
      {
        id: 'main',
        name: 'Main',
        resources: [],
        contributions: [
          { type: 'identity', id: 'fixture-identity' },
          { type: 'message-subscription', id: 'fixture-subscription' },
        ],
        capabilities: ['message.event.subscribe', 'thread.write'],
      },
    ],
    configuration: [{ key: 'initializationGate', label: 'Initialization gate', kind: 'string', required: false }],
    runtime: { transport: 'builtin', entrypoint: 'dist/plugin.js' },
  };
  await mkdir(join(packageRoot, 'dist'), { recursive: true });
  await writeFile(join(packageRoot, 'manifest.json'), `${JSON.stringify(manifest)}\n`, 'utf8');
  await writeFile(
    join(packageRoot, 'dist/plugin.js'),
    [
      observation.source,
      'export default { create() { return {',
      '  async start(host) {',
      '    const thread = state.threadId ? await host.threads.get(state.threadId) : await host.threads.create({ title: "Fixture" });',
      '    state.threadId = thread.id;',
      '    saveState();',
      "    await host.messaging.subscribe({ threadId: thread.id, method: 'fixture.outbound' });",
      '    state.restored = true; saveState();',
      "    await host.config.get('initializationGate');",
      '    return {',
      "      actions: { 'fixture.outbound': async (input) => { if(input.kind==='message') { state.calls.push(input); state.sequence.push('message'); } else { state.lifecycleCalls.push(input); state.sequence.push(input.state); } saveState(); return {deliveryId:input.deliveryId}; } },",
      '      stop() {},',
      '    };',
      '  },',
      '} } };',
      '',
    ].join('\n'),
    'utf8',
  );

  const stores = createMessagingStores();
  const failures = [];
  const scheduler = new SubscriptionDrainScheduler((error, threadId) => failures.push({ error, threadId }));
  const messageStore = createPublishingMessageStore(new MessageStore(), {
    events: stores.events,
    onPublished: scheduler.schedule,
    onPublishFailure: (error, stored) => failures.push({ error, threadId: stored.threadId }),
  });
  const threadStore = new ThreadStore();
  let startingPaused = false;
  const startupGate = Promise.withResolvers();
  const runtime = createDormantPluginRuntimeComposition({
    projectRoot,
    configuration: {
      async readConfig(_instanceId, key) {
        if (recovering && key === 'initializationGate' && observation.read().restored) {
          startingPaused = true;
          await startupGate.promise;
        }
        return undefined;
      },
      async readSecret() {
        return undefined;
      },
    },
    messageStore,
    lifecyclePresentation: async () => ({
      actor: { displayName: 'Fixture Cat', emoji: '🐱' },
      thread: { shortId: 'fixture-thread' },
    }),
    messagingStores: stores,
    onMessagePublished: scheduler.schedule,
    threadStore,
    threadBindingStore: new MemoryConnectorThreadBindingStore(),
    threadOwnerUserId: 'owner-1',
    contract: { manifestContractRange: '0.1.0', validateManifest },
  });
  runtimes.push(runtime);
  scheduler.attach(runtime.subscriptionDelivery);
  const manager = createPluginManagerRuntimeComposition({
    runtime,
    catalogProvider: { snapshot: async () => ({ entries: [], status: 'fresh', checkedAt: 1 }) },
    catalogManifests: [],
  }).manager;

  const installed = await manager.install({ source: { kind: 'local-directory', path: packageRoot } });
  const beforeEnable = (await manager.get(installed.pluginId)).plugin;
  if (recovering) {
    const thread = await threadStore.create('owner-1', 'Recovered thread');
    await writeFile(
      join(projectRoot, 'subscription-observation.json'),
      JSON.stringify({ ...observation.read(), threadId: thread.id }),
    );
    const instanceId = beforeEnable.pluginInstanceId;
    const { handleId } = await runtime.messaging.ensureThreadHandle({
      pluginInstanceId: instanceId,
      threadId: thread.id,
      userId: 'owner-1',
      scope: { canSend: false, canSubscribe: true },
    });
    const { subscriptionId } = await runtime.messaging.subscribe({ pluginInstanceId: instanceId }, handleId);
    await messageStore.append({
      from: { kind: 'agent', catId: 'opus' },
      threadId: thread.id,
      userId: 'owner-1',
      content: 'pending before Host restart',
      timestamp: 1,
    });
    const enabling = manager.setEnabled(installed.pluginId, {
      enabled: true,
      expectedRevision: beforeEnable.lifecycleRevision,
    });
    try {
      await waitFor(() => startingPaused, 'package did not pause after restoring its subscription', 10_000);
      await runtime.subscriptionDelivery.drain(thread.id);
      assert.equal(failures.length, 0, 'initialization must defer delivery, not fail then retry');
      assert.equal(observation.read().calls.length, 0);
    } finally {
      startupGate.resolve();
    }
    await enabling;
    await waitFor(() => observation.read().calls.length === 1, 'ready activation never resumed the recovered cursor');
    await runtime.subscriptionDelivery.enqueueThread(thread.id, async () => {});
    assert.equal((await stores.cursors.get(instanceId, subscriptionId)).ackedSequence, 1);
    assert.equal(observation.read().calls[0].envelope.payload.elements[0].payload.text, 'pending before Host restart');
    return;
  }
  await manager.setEnabled(installed.pluginId, { enabled: true, expectedRevision: beforeEnable.lifecycleRevision });
  let state = observation.read();
  assert.ok(state?.threadId, 'the installed package must reach its Host subscription surface');

  await Promise.all([
    messageStore.append({
      from: { kind: 'agent', catId: 'opus' },
      threadId: state.threadId,
      userId: 'owner-1',

      content: 'first reply',
      timestamp: 1,
    }),
    messageStore.append({
      from: { kind: 'agent', catId: 'codex' },
      threadId: state.threadId,
      userId: 'owner-1',

      content: 'second reply',
      timestamp: 2,
    }),
  ]);
  await waitFor(() => observation.read().calls.length === 2, 'installed package did not receive both cat replies');
  await new Promise((resolve) => setTimeout(resolve, 20));
  state = observation.read();

  assert.equal(state.calls.length, 2, 'concurrent drains must not duplicate either reply');
  assert.deepEqual(state.calls.map((call) => call.envelope.payload.elements[0].payload.text).sort(), [
    'first reply',
    'second reply',
  ]);
  assert.ok(state.calls.every((call) => call.threadId === state.threadId));
  assert.deepEqual(failures, []);

  const card = { id: 'card-1', kind: 'card', v: 1, title: 'Approval', bodyMarkdown: 'Review the proposal' };
  const checklist = { id: 'checklist-1', kind: 'checklist', v: 1, title: 'Steps', items: [] };
  const audio = { id: 'audio-1', kind: 'audio', v: 1, url: '/api/tts/audio/private' };
  await messageStore.append({
    from: { kind: 'agent', catId: 'opus' },
    threadId: state.threadId,
    userId: 'owner-1',

    content: 'rich reply',
    timestamp: 3,
    extra: { rich: { v: 1, blocks: [card, audio, checklist] } },
  });
  await waitFor(() => observation.read().calls.length === 3, 'installed package did not receive the rich reply');
  state = observation.read();
  assert.deepEqual(
    state.calls[2].envelope.payload.elements.map((element) => element.kind),
    ['text', 'rich_block', 'rich_block'],
  );
  assert.deepEqual(
    state.calls[2].envelope.payload.elements.slice(1).map((element) => element.payload),
    [card, checklist],
  );

  const invocationId = 'invocation-production-lifecycle-1';
  await runtime.lifecycleDelivery.onStreamStart(state.threadId, 'opus', invocationId);
  await runtime.lifecycleDelivery.onClosureCatchingUp(state.threadId, 'opus', invocationId);
  await messageStore.append({
    from: { kind: 'agent', catId: 'opus' },
    threadId: state.threadId,
    userId: 'owner-1',

    content: 'lifecycle reply',
    timestamp: 4,
    extra: { stream: { invocationId } },
  });
  await runtime.lifecycleDelivery.onStreamEnd(state.threadId, '', invocationId);
  await runtime.lifecycleDelivery.notifyDeliveryBatchDone(state.threadId, true, 'succeeded', invocationId);
  state = observation.read();
  assert.deepEqual(state.sequence.slice(-4), ['started', 'catching_up', 'message', 'settled']);
  assert.equal(state.lifecycleCalls[0].threadId, state.threadId);
  assert.equal(state.lifecycleCalls[0].presentation.actor.displayName, 'Fixture Cat');
  assert.equal(state.calls[3].executionId, state.lifecycleCalls[0].executionId);
  assert.equal(state.lifecycleCalls[1].executionId, state.lifecycleCalls[0].executionId);
  assert.equal(state.lifecycleCalls[2].executionId, state.lifecycleCalls[0].executionId);

  const beforeDisable = (await manager.get(pluginId)).plugin;
  await manager.setEnabled(pluginId, { enabled: false, expectedRevision: beforeDisable.lifecycleRevision });
  await messageStore.append({
    from: { kind: 'agent', catId: 'opus' },
    threadId: state.threadId,
    userId: 'owner-1',

    content: 'disabled reply',
    timestamp: 3,
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  state = observation.read();
  assert.equal(state.calls.length, 4, 'disabled packages must be absent from the live delivery set');
}

test('production composition delivers concurrent cat replies exactly once to an installed package action', () =>
  productionSubscriptionScenario(false));
test('production activation replays a restored unacked cursor after slow package startup', () =>
  productionSubscriptionScenario(true));
