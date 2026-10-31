import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { CONCIERGE_CONFIG_DEFAULTS, createCatId } from '@cat-cafe/shared';
import Fastify from 'fastify';
import { MessageStore } from '../src/domains/cats/services/stores/ports/MessageStore.js';
import { ThreadStore } from '../src/domains/cats/services/stores/ports/ThreadStore.js';
import { MemoryConciergeConfigStore } from '../src/domains/concierge/ConciergeConfigStore.js';
import { MemoryConciergeConfirmationStore } from '../src/domains/concierge/ConciergeConfirmationStore.js';
import { MemoryConciergeRelayStore } from '../src/domains/concierge/ConciergeRelayStore.js';
import { ConciergeThreadService } from '../src/domains/concierge/ConciergeThreadService.js';
import { LiveCompanionSessions } from '../src/domains/concierge/live/LiveCompanionSessions.js';
import {
  createLiveConfigChange,
  requiresLiveConfigStop,
} from '../src/domains/concierge/live/live-config-transition.js';
import { conciergeRoutes } from '../src/routes/concierge.js';

test('permission writes through the existing route await physical media revocation and call closure; unconfirmed revocation writes nothing', async () => {
  const app = Fastify();
  const config = new MemoryConciergeConfigStore();
  await config.put('owner', { ...CONCIERGE_CONFIG_DEFAULTS, householdReadsAllowed: true });
  const put = config.put.bind(config);
  let loseWriteReply = false;
  config.put = async (userId, value) => {
    await put(userId, value);
    if (loseWriteReply) throw new Error('save acknowledgement lost');
  };
  const sessions = new LiveCompanionSessions();
  const messages = new MessageStore();
  const options = {
    binding: { userId: 'owner', threadId: 'home', catId: createCatId('codex-astra'), callId: 'old' },
    messageStore: messages,
    mcpDistDir: resolve('../mcp-server/dist'),
    allowedDirectories: [],
    verifyNativeBinding: async () => true,
    publish() {},
  };
  const call = await sessions.prepare(options);
  let revoked = false;
  let begin!: () => void;
  let release!: () => void;
  const began = new Promise<void>((resolve) => {
    begin = resolve;
  });
  const permission = new Promise<void>((resolve) => {
    release = resolve;
  });
  let reject = false;
  await app.register(conciergeRoutes, {
    conciergeConfigStore: config,
    conciergeThreadService: new ConciergeThreadService({
      conciergeConfigStore: config,
      threadStore: new ThreadStore(),
    }),
    conciergeRelayStore: new MemoryConciergeRelayStore(),
    conciergeConfirmationStore: new MemoryConciergeConfirmationStore(),
    messageStore: messages,
    withLiveConfigChange: createLiveConfigChange({
      store: config,
      sessions,
      ownerUserId: 'owner',
      revokeMedia: async () => {
        begin();
        await permission;
        if (reject) throw new Error('native media close unconfirmed');
        revoked = true;
      },
    }),
  });
  const headers = { 'x-cat-cafe-user': 'owner' };
  try {
    const changing = app.inject({
      method: 'PUT',
      url: '/api/concierge/config',
      headers,
      payload: { householdReadsAllowed: false },
    });
    await Promise.race([began, changing.then(() => assert.fail('settings completed before capture revocation began'))]);
    assert.equal((await config.get('owner')).householdReadsAllowed, true);
    assert.equal(call.status().state, 'preparing');
    await assert.rejects(sessions.prepare({ ...options, binding: { ...options.binding, callId: 'raced' } }), /active/);
    release();
    const changed = await changing;
    assert.equal(changed.statusCode, 200);
    assert.equal(changed.json().callStatus, 'stopped');
    assert.equal(revoked, true);
    assert.equal(call.status().state, 'closed');
    assert.equal((await config.get('owner')).householdReadsAllowed, false);
    const next = await sessions.prepare({ ...options, binding: { ...options.binding, callId: 'next' } });
    const unchanged = await app.inject({
      method: 'PUT',
      url: '/api/concierge/config',
      headers,
      payload: { householdReadsAllowed: false },
    });
    assert.equal(unchanged.statusCode, 200);
    assert.equal(unchanged.json().callStatus, 'unchanged');
    assert.equal(next.status().state, 'preparing', 'saving the current choice does not end the call');
    reject = true;
    const failed = await app.inject({
      method: 'PUT',
      url: '/api/concierge/config',
      headers,
      payload: { householdReadsAllowed: true },
    });
    assert.equal(failed.statusCode, 503);
    assert.equal(failed.json().callStatus, 'stop_failed');
    assert.equal((await config.get('owner')).householdReadsAllowed, false);
    const visual = await app.inject({
      method: 'PUT',
      url: '/api/concierge/config',
      headers,
      payload: { ballPosition: { x: 1, y: 2 }, behaviorEnabled: false },
    });
    assert.equal(visual.statusCode, 200, 'geometry and autonomous preference do not open or close media');
    const tone = await app.inject({
      method: 'PUT',
      url: '/api/concierge/config',
      headers,
      payload: { personaTone: 'calm' },
    });
    assert.equal(tone.statusCode, 200);
    assert.equal(next.status().state, 'preparing', 'tone affects the next call without mutating current media');
    reject = false;
    loseWriteReply = true;
    const unknown = await app.inject({
      method: 'PUT',
      url: '/api/concierge/config',
      headers,
      payload: { householdReadsAllowed: true },
    });
    assert.equal(unknown.statusCode, 503);
    assert.equal(unknown.json().phase, 'save');
    assert.equal(unknown.json().code, 'configuration_write_unconfirmed');
    assert.equal(unknown.json().callStatus, 'stopped');
    assert.equal(next.status().state, 'closed');
    assert.equal(
      (await app.inject({ url: '/api/concierge/config', headers })).json().config.householdReadsAllowed,
      true,
      'lost acknowledgement does not imply rollback; reconcile from the one configuration store',
    );
    assert.equal(await sessions.observeCall('owner'), null, 'saving or retrying never reconnects media');
  } finally {
    await sessions.close();
    await app.close();
  }
});

test('the preparation snapshot changes only for changed duty or read permission, including legacy default read permission', () => {
  const config = { ...CONCIERGE_CONFIG_DEFAULTS, dutyCatProfileId: 'opus' };
  assert.equal(requiresLiveConfigStop(config, { householdReadsAllowed: true }), false);
  assert.equal(requiresLiveConfigStop(config, { householdReadsAllowed: false }), true);
  assert.equal(requiresLiveConfigStop(config, { dutyCatProfileId: 'opus' }), false);
  assert.equal(requiresLiveConfigStop(config, { dutyCatProfileId: 'fable-5' }), true);
  assert.equal(
    requiresLiveConfigStop(config, { personaTone: 'quiet', behaviorEnabled: false, skin: 'yarn-ball' }),
    false,
  );
});

test('a timed-out write returns reconciliation truth while retaining the transition fence until settlement', async (t) => {
  const app = Fastify();
  const store = new MemoryConciergeConfigStore();
  const sessions = new LiveCompanionSessions();
  const messages = new MessageStore();
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const put = store.put.bind(store);
  store.put = async (userId, config) => {
    await put(userId, config);
    await held;
  };
  t.after(async () => {
    release();
    await sessions.close();
    await app.close();
  });
  const options = {
    binding: { userId: 'owner', threadId: 'home', catId: createCatId('codex-astra'), callId: 'old' },
    messageStore: messages,
    mcpDistDir: resolve('../mcp-server/dist'),
    allowedDirectories: [],
    verifyNativeBinding: async () => true,
    publish() {},
  };
  const call = await sessions.prepare(options);
  await app.register(conciergeRoutes, {
    conciergeConfigStore: store,
    conciergeThreadService: new ConciergeThreadService({ conciergeConfigStore: store, threadStore: new ThreadStore() }),
    conciergeRelayStore: new MemoryConciergeRelayStore(),
    conciergeConfirmationStore: new MemoryConciergeConfirmationStore(),
    messageStore: messages,
    configWriteTimeoutMs: 20,
    withLiveConfigChange: createLiveConfigChange({
      store,
      sessions,
      ownerUserId: 'owner',
      revokeMedia: async () => {},
    }),
  });
  const headers = { 'x-cat-cafe-user': 'owner' };
  const writing = app.inject({
    method: 'PUT',
    url: '/api/concierge/config',
    headers,
    payload: { householdReadsAllowed: false },
  });
  const response = await Promise.race([writing, new Promise<null>((resolve) => setTimeout(() => resolve(null), 200))]);
  assert.ok(response, 'the owner receives bounded unknown settlement without waiting for a hung store');
  assert.equal(response.statusCode, 503);
  assert.equal(response.json().code, 'configuration_write_unconfirmed');
  assert.equal(response.json().callStatus, 'stopped');
  assert.equal(call.status().state, 'closed');
  assert.equal((await store.getSaved('owner')).householdReadsAllowed, false, 'timeout does not claim rollback');
  await assert.rejects(
    sessions.prepare({ ...options, binding: { ...options.binding, callId: 'too-early' } }),
    /active/,
  );
  const second = await app.inject({
    method: 'PUT',
    url: '/api/concierge/config',
    headers,
    payload: { skin: 'ragdoll-v1' },
  });
  assert.equal(second.statusCode, 409, 'a timed-out write cannot race a later full configuration write');
  release();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(await sessions.observeCall('owner'), null, 'settlement never reconnects the stopped call');
  const retry = await app.inject({
    method: 'PUT',
    url: '/api/concierge/config',
    headers,
    payload: { skin: 'ragdoll-v1' },
  });
  assert.equal(retry.statusCode, 200);
  assert.equal(retry.json().callStatus, 'unchanged');
  assert.equal((await store.getSaved('owner')).householdReadsAllowed, false);
});
