import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CONCIERGE_CONFIG_DEFAULTS } from '@cat-cafe/shared';
import cookie from '@fastify/cookie';
import Fastify from 'fastify';
import { MessageStore } from '../src/domains/cats/services/stores/ports/MessageStore.js';
import { ThreadStore } from '../src/domains/cats/services/stores/ports/ThreadStore.js';
import { MemoryConciergeConfigStore } from '../src/domains/concierge/ConciergeConfigStore.js';
import { MemoryConciergeConfirmationStore } from '../src/domains/concierge/ConciergeConfirmationStore.js';
import { MemoryConciergeRelayStore } from '../src/domains/concierge/ConciergeRelayStore.js';
import { ConciergeThreadService } from '../src/domains/concierge/ConciergeThreadService.js';
import { LiveCompanionSessions } from '../src/domains/concierge/live/LiveCompanionSessions.js';
import { createLiveConfigChange } from '../src/domains/concierge/live/live-config-transition.js';
import { readPluginConfig } from '../src/domains/plugin/plugin-config-store.js';
import { sessionAuthPlugin, sessionRoute } from '../src/infrastructure/session-auth.js';
import { conciergeRoutes } from '../src/routes/concierge.js';
import { companionConfigurationFixture } from './helpers/companion-configuration-fixture.js';

test('settings view reads the saved plugin selection and refuses header-only or proxied readers', async (t) => {
  const previousOwner = process.env.DEFAULT_OWNER_USER_ID;
  process.env.DEFAULT_OWNER_USER_ID = 'settings-owner';
  const app = Fastify();
  t.after(async () => {
    await app.close();
    if (previousOwner === undefined) delete process.env.DEFAULT_OWNER_USER_ID;
    else process.env.DEFAULT_OWNER_USER_ID = previousOwner;
  });
  await app.register(cookie);
  await app.register(sessionAuthPlugin);
  await app.register(sessionRoute, { ownerUserId: 'settings-owner' });
  const config = new MemoryConciergeConfigStore();
  const companion = companionConfigurationFixture({ dutyCatProfileId: 'retired-selected-profile' });
  let settingsReadable = true;
  const companionSettings = async () => {
    if (!settingsReadable) throw new Error('source temporarily unreachable');
    return companion.read();
  };
  const threadStore = new ThreadStore();
  const sessions = new LiveCompanionSessions();
  t.after(() => sessions.close());
  let revocations = 0;
  await config.put('settings-owner', { ...CONCIERGE_CONFIG_DEFAULTS });
  await app.register(conciergeRoutes, {
    conciergeConfigStore: config,
    companionSettings,
    conciergeThreadService: new ConciergeThreadService({ companionSettings, threadStore }),
    conciergeRelayStore: new MemoryConciergeRelayStore(),
    conciergeConfirmationStore: new MemoryConciergeConfirmationStore(),
    messageStore: new MessageStore(),
    withLiveConfigChange: createLiveConfigChange({
      store: config,
      sessions,
      ownerUserId: 'settings-owner',
      revokeMedia: async () => {
        revocations++;
      },
    }),
  });
  const login = await app.inject({ url: '/api/session' });
  const headers = { cookie: String(login.headers['set-cookie']).split(';')[0]!, origin: 'http://localhost:5102' };
  const url = '/api/concierge/config?view=settings';
  const read = await app.inject({ url, headers });
  assert.equal(read.statusCode, 200);
  assert.equal(read.json().config.dutyCatProfileId, 'retired-selected-profile');
  assert.equal(read.json().config.ballSize, 72, 'manifest default');
  assert.equal(read.json().selectedCompanionStatus, 'unavailable');
  assert.equal(read.headers['cache-control'], 'no-store');
  for (const view of ['settings', 'native']) {
    const endpoint = `/api/concierge/config?view=${view}`;
    const untrusted = await app.inject({ url: endpoint, headers: { 'x-cat-cafe-user': 'settings-owner' } });
    assert.equal(untrusted.statusCode, 401);
    const proxied = await app.inject({ url: endpoint, headers: { ...headers, 'x-forwarded-for': '203.0.113.10' } });
    assert.equal(proxied.statusCode, 403);
  }
  const ordinary = await app.inject({
    method: 'PUT',
    url: '/api/concierge/config',
    headers,
    payload: { householdReadsAllowed: true },
  });
  assert.equal(ordinary.statusCode, 200);
  assert.deepEqual(
    readPluginConfig(companion.projectRoot, 'official.companion'),
    { dutyCatProfileId: 'retired-selected-profile' },
    'a runtime write cannot touch the plugin configuration',
  );
  settingsReadable = false;
  const sourceFailure = await app.inject({ url, headers });
  assert.equal(sourceFailure.statusCode, 503);
  assert.equal(sourceFailure.json().reason, 'temporarily_unavailable');
  config.get = async () => {
    throw new Error('source temporarily unreachable');
  };
  const rejectedWrite = await app.inject({
    method: 'PUT',
    url: '/api/concierge/config',
    headers,
    payload: { householdReadsAllowed: false },
  });
  assert.equal(rejectedWrite.statusCode, 503);
  assert.equal(rejectedWrite.json().code, 'configuration_read_failed');
  assert.equal(rejectedWrite.json().callStatus, 'unchanged');
  assert.equal(revocations, 0, 'a failed preference read cannot be reported as a failed media stop');
});
