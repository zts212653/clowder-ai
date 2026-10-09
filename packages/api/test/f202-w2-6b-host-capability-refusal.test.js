/**
 * F202 W2-6b — the Host recognizes its own capability refusals (ledger「W2-6b」(2)).
 *
 * Every Host site that refuses a plugin a capability it was not granted registers the error it
 * throws. The error itself is unchanged — same class, code and text — so a plugin sees nothing new;
 * only the Host can tell its refusal apart from any error that merely reads the same.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MessagingError } from '../dist/domains/messaging/contract/host-types.js';
import { admitCloudConversationHosts } from '../dist/domains/plugin/declared/declared-cloud-conversation-hosts.js';
import { DeclaredRuntimeContributions } from '../dist/domains/plugin/declared/declared-runtime-contributions.js';
import { ExternalPluginRuntimeError } from '../dist/domains/plugin/external-runtime/types.js';
import {
  hostCapabilityRefusal,
  refusedHostCapability,
} from '../dist/domains/plugin/host-surface/host-capability-refusal.js';
import {
  createUnavailablePluginMediaHost,
  PluginMediaReadService,
} from '../dist/domains/plugin/host-surface/plugin-media-host.js';
import { createPluginMessagingHost } from '../dist/domains/plugin/host-surface/plugin-messaging-host.js';
import { createPluginMessagingSubscriptionSession } from '../dist/domains/plugin/host-surface/plugin-messaging-subscription-host.js';
import { createPluginStorageHost } from '../dist/domains/plugin/host-surface/plugin-private-storage.js';
import { createPluginTaskHost } from '../dist/domains/plugin/host-surface/plugin-task-host.js';
import { createPluginThreadHost } from '../dist/domains/plugin/host-surface/plugin-thread-host.js';
import {
  ManifestConfigurationProjectionError,
  resolveManifestConfiguration,
} from '../dist/domains/plugin/manifest-configuration-projection.js';

const PLUGIN_ID = 'dev.example.w26b';
const INSTANCE_ID = 'pi_w26b';

/** Runs `attempt`, expecting the Host to refuse `capability`; returns what was thrown. */
async function refusal(attempt, capability) {
  let thrown;
  try {
    await attempt();
  } catch (error) {
    thrown = error;
  }
  assert.ok(thrown, `expected the Host to refuse ${capability}`);
  assert.equal(refusedHostCapability(thrown), capability, `registered refusal of ${capability}`);
  return thrown;
}

test('found directly, through causes and aggregates; an error that only reads the same is not a refusal', () => {
  const refused = hostCapabilityRefusal(
    new ExternalPluginRuntimeError('DELIVERY_REJECTED', `${PLUGIN_ID} lacks thread.listMetadata`),
    'thread.listMetadata',
  );
  assert.equal(refusedHostCapability(refused), 'thread.listMetadata');
  assert.equal(refusedHostCapability(new Error('bind failed', { cause: refused })), 'thread.listMetadata');
  assert.equal(
    refusedHostCapability(new AggregateError([new Error('other'), new Error('wrapped', { cause: refused })], 'x')),
    'thread.listMetadata',
  );

  const lookalike = new ExternalPluginRuntimeError('DELIVERY_REJECTED', `${PLUGIN_ID} lacks thread.listMetadata`);
  assert.equal(refusedHostCapability(lookalike), undefined, 'same class, code and text, but not the Host refusing');
  assert.equal(refusedHostCapability(Object.assign(new Error(refused.message), { code: refused.code })), undefined);
  assert.equal(refusedHostCapability('thread.listMetadata'), undefined);
  assert.equal(refusedHostCapability(undefined), undefined);
});

test('the lookup is bounded, cycle-safe and never throws', () => {
  const first = new Error('first');
  const second = new Error('second', { cause: first });
  first.cause = second;
  assert.equal(refusedHostCapability(first), undefined);

  let deep = hostCapabilityRefusal(new Error('deep'), 'plugin.state.get');
  for (let level = 0; level < 100; level += 1) deep = new Error(`level ${level}`, { cause: deep });
  assert.equal(refusedHostCapability(deep), undefined, 'a refusal beyond the bound is not searched for');

  const hostile = new Proxy(new Error('proxied'), {
    get() {
      throw new Error('trap');
    },
    has() {
      throw new Error('trap');
    },
    getPrototypeOf() {
      throw new Error('trap');
    },
  });
  assert.equal(refusedHostCapability(hostile), undefined);
});

test('thread host: each of its three capabilities, refused as before and registered', async () => {
  const threads = createPluginThreadHost({
    threadDeepLinkUrl: (id) => `https://cafe.example.test/thread/${encodeURIComponent(id)}`,
    pluginId: PLUGIN_ID,
    pluginInstanceId: INSTANCE_ID,
    ownerUserId: 'owner-1',
    projectPath: '/tmp',
    effectiveGrants: [],
    systemThreadTitle: 'W2-6b',
    threadStore: {},
    bindingStore: {},
  });
  const listed = await refusal(() => threads.listBindings(), 'thread.listMetadata');
  assert.ok(listed instanceof ExternalPluginRuntimeError);
  assert.equal(listed.code, 'DELIVERY_REJECTED');
  assert.equal(listed.message, `${PLUGIN_ID} lacks thread.listMetadata`);
  await refusal(() => threads.get('thread-1'), 'thread.readContent');
  await refusal(() => threads.ensureSystemThread(), 'thread.write');
});

test('private storage and tasks: read and write refusals are registered', async () => {
  const storage = createPluginStorageHost({ pluginId: PLUGIN_ID, effectiveGrants: [] });
  const get = await refusal(() => storage.get('k'), 'plugin.state.get');
  assert.equal(get.message, `${PLUGIN_ID} lacks plugin.state.get`);
  await refusal(() => storage.set('k', 'v'), 'plugin.state.set');

  const tasks = createPluginTaskHost({ pluginId: PLUGIN_ID, effectiveGrants: [] });
  await refusal(() => tasks.get('task-1'), 'task.read');
  await refusal(() => tasks.create({}), 'task.write');
});

test('messaging: send and subscribe refusals keep their MessagingError and are registered', async () => {
  const deps = {
    pluginId: PLUGIN_ID,
    pluginInstanceId: INSTANCE_ID,
    ownerUserId: 'owner-1',
    effectiveGrants: [],
    manifest: { pluginId: PLUGIN_ID },
    threadStore: {},
    bindingStore: {},
    messaging: {},
    delivery: {},
  };
  const send = await refusal(() => createPluginMessagingHost(deps).send({}), 'messaging.send');
  assert.ok(send instanceof MessagingError);
  assert.equal(send.code, 'PERMISSION');
  assert.equal(send.message, `${PLUGIN_ID} lacks messaging.send`);

  const session = createPluginMessagingSubscriptionSession(deps);
  await refusal(() => session.host.subscribe({ threadId: 'thread-1' }), 'message.event.subscribe');
});

test('media: both the live and the unavailable media host register a media.read refusal', async () => {
  const service = new PluginMediaReadService({ ledger: {}, entitlements: {} });
  const live = await refusal(
    () => service.read({ pluginInstanceId: INSTANCE_ID, effectiveGrants: [] }, {}),
    'media.read',
  );
  assert.equal(live.code, 'PERMISSION');
  await refusal(() => createUnavailablePluginMediaHost([]).read({}), 'media.read');

  let denied;
  try {
    await createUnavailablePluginMediaHost(['media.read']).read({});
  } catch (error) {
    denied = error;
  }
  assert.equal(denied.code, 'MEDIA_ACCESS_DENIED');
  assert.equal(
    refusedHostCapability(denied),
    undefined,
    'a granted instance denied an item is not a capability refusal',
  );
});

test('configuration: a required field the instance may not read registers its grant', async () => {
  const input = (field) => ({
    pluginInstanceId: INSTANCE_ID,
    manifest: { configuration: [field] },
    effectiveGrants: [],
    configuration: { readConfig: async () => 'v', readSecret: async () => 's' },
  });
  const secret = await refusal(
    () => resolveManifestConfiguration(input({ key: 'BOT_TOKEN', label: 'Bot', kind: 'secret', required: true })),
    'secret.read',
  );
  assert.ok(secret instanceof ManifestConfigurationProjectionError);
  assert.equal(secret.failure.reason, 'grant_unavailable');
  await refusal(
    () => resolveManifestConfiguration(input({ key: 'API_BASE', label: 'API', kind: 'string', required: true })),
    'plugin.config.read',
  );
});

function admission(contributions) {
  return {
    instance: { pluginInstanceId: INSTANCE_ID },
    packageRecord: {
      pluginId: PLUGIN_ID,
      manifest: { pluginId: PLUGIN_ID, contributions, runtime: { transport: 'builtin' } },
    },
    effectiveGrants: [],
  };
}

test('declared contributions: schedule.register and cloud.conversation.host refusals are registered', async () => {
  const schedule = {
    type: 'schedule',
    id: 'tick',
    schedule: { kind: 'interval', everyMs: 60_000 },
    action: { method: 'fixture.tick' },
    policy: { overlap: 'skip', timeoutMs: 5_000 },
  };
  const contributions = new DeclaredRuntimeContributions({ packages: {}, configuration: {}, taskRunner: {} });
  await refusal(() => contributions.activate(admission([schedule]), async () => undefined), 'schedule.register');

  const host = { type: 'cloud-conversation-host', id: 'cloud', provider: 'gpt-pro' };
  await refusal(
    () =>
      admitCloudConversationHosts(
        admission([host]),
        [host],
        {},
        { attempt: async () => undefined, exposes: () => true },
      ),
    'cloud.conversation.host',
  );
});
