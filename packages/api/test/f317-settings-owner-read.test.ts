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
import { sessionAuthPlugin, sessionRoute } from '../src/infrastructure/session-auth.js';
import { conciergeRoutes } from '../src/routes/concierge.js';

test('settings view reads the saved owner selection and refuses header-only or proxied readers', async (t) => {
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
  const threadStore = new ThreadStore();
  const sessions = new LiveCompanionSessions();
  t.after(() => sessions.close());
  let revocations = 0;
  await config.put('settings-owner', { ...CONCIERGE_CONFIG_DEFAULTS, dutyCatProfileId: 'retired-selected-profile' });
  await app.register(conciergeRoutes, {
    conciergeConfigStore: config,
    conciergeThreadService: new ConciergeThreadService({
      conciergeConfigStore: config,
      threadStore,
    }),
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
  assert.equal(read.json().selectedCompanionStatus, 'unavailable');
  assert.equal(read.headers['cache-control'], 'no-store');
  assert.notEqual(
    (await app.inject({ url: '/api/concierge/config', headers })).json().config.dutyCatProfileId,
    'retired-selected-profile',
  );
  for (const view of ['settings', 'native']) {
    const endpoint = `/api/concierge/config?view=${view}`;
    const untrusted = await app.inject({ url: endpoint, headers: { 'x-cat-cafe-user': 'settings-owner' } });
    assert.equal(untrusted.statusCode, 401);
    const proxied = await app.inject({ url: endpoint, headers: { ...headers, 'x-forwarded-for': '203.0.113.10' } });
    assert.equal(proxied.statusCode, 403);
  }
  const visual = await app.inject({ method: 'PUT', url: '/api/concierge/config', headers, payload: { ballSize: 96 } });
  assert.equal(visual.statusCode, 200);
  assert.equal(
    (await config.getSaved('settings-owner')).dutyCatProfileId,
    'retired-selected-profile',
    'an unrelated settings write cannot replace the saved selection',
  );
  assert.equal((await config.getSaved('settings-owner')).ballSize, 96);
  const opened = await app.inject({ method: 'POST', url: '/api/concierge/thread', headers });
  assert.equal(opened.statusCode, 200);
  const before = (await threadStore.get(opened.json().threadId))?.preferredCats;
  const ordinary = await app.inject({ method: 'PUT', url: '/api/concierge/config', headers, payload: { muted: true } });
  const effective = (await app.inject({ url: '/api/concierge/config', headers })).json().config;
  assert.equal(ordinary.json().config.dutyCatProfileId, effective.dutyCatProfileId);
  assert.deepEqual((await threadStore.get(opened.json().threadId))?.preferredCats, before);
  assert.equal((await config.getSaved('settings-owner')).dutyCatProfileId, 'retired-selected-profile');
  const savedRead = config.getSaved.bind(config);
  config.getSaved = async () => {
    throw new Error('source temporarily unreachable');
  };
  const sourceFailure = await app.inject({ url, headers });
  assert.equal(sourceFailure.statusCode, 503);
  assert.equal(sourceFailure.json().reason, 'temporarily_unavailable');
  const rejectedWrite = await app.inject({
    method: 'PUT',
    url: '/api/concierge/config',
    headers,
    payload: { personaTone: 'calm' },
  });
  assert.equal(rejectedWrite.statusCode, 503);
  assert.equal(rejectedWrite.json().code, 'configuration_read_failed');
  assert.equal(rejectedWrite.json().callStatus, 'unchanged');
  assert.equal(revocations, 0, 'a failed preference read cannot be reported as a failed media stop');
  assert.equal((await savedRead('settings-owner')).personaTone, CONCIERGE_CONFIG_DEFAULTS.personaTone);
});
