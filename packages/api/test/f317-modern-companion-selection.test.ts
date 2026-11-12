import assert from 'node:assert/strict';
import { type TestContext, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { catRegistry } from '@cat-cafe/shared';
import cookie from '@fastify/cookie';
import Fastify from 'fastify';
import { getRoster, loadCatConfig, toAllCatConfigs } from '../src/config/cat-config-loader.js';
import { MessageStore } from '../src/domains/cats/services/stores/ports/MessageStore.js';
import { LiveCompanionSessions } from '../src/domains/concierge/live/LiveCompanionSessions.js';
import type { LiveCompanionCallOptions } from '../src/domains/concierge/live/live-call-options.js';
import { sessionAuthPlugin, sessionRoute } from '../src/infrastructure/session-auth.js';
import { conciergeLiveRoutes } from '../src/routes/concierge-live.js';
import { companionConfigurationFixture } from './helpers/companion-configuration-fixture.js';
import { createIsolatedTemplateRoot } from './helpers/isolated-template-root.js';

async function fixture(t: TestContext) {
  const isolated = createIsolatedTemplateRoot(
    '/tmp',
    fileURLToPath(new URL('../../../cat-template.json', import.meta.url)),
  );
  t.after(isolated.cleanup);
  const template = loadCatConfig(isolated.templatePath);
  getRoster(template);
  const cats = Object.values(toAllCatConfigs(template));
  for (const cat of cats) if (!catRegistry.has(cat.id)) catRegistry.register(cat.id, cat);
  const carrier = cats.find((cat) => cat.clientId === 'openai' && cat.provider !== 'openai-chatgpt-pro');
  assert.ok(carrier);
  const owner = 'modern-selection-owner';
  const priorOwner = process.env.DEFAULT_OWNER_USER_ID;
  process.env.DEFAULT_OWNER_USER_ID = owner;
  const app = Fastify();
  const companion = companionConfigurationFixture();
  const sessions = new LiveCompanionSessions();
  const allocations: string[] = [];
  t.mock.method(sessions, 'prepare', async (options: LiveCompanionCallOptions) => {
    assert.ok(options.companion);
    allocations.push(options.companion.duty.catId);
    throw new Error('test stops before allocating native or media resources');
  });
  await app.register(cookie);
  await app.register(sessionAuthPlugin);
  await app.register(sessionRoute, { ownerUserId: owner });
  await app.register(conciergeLiveRoutes, {
    ownerUserId: owner,
    companionSettings: companion.read,
    sessions,
    threadService: { getOrCreate: async () => 'home', isCurrent: async () => true },
    sessionChainStore: { getActive: async () => null },
    messageStore: new MessageStore(),
    invocationQueue: { getQueuedBodyMessagesForCat: () => [], getEntrySnapshot: () => null },
    recovery: {
      tasks: { get: () => null, listByThread: () => [] },
      approvals: { listSettled: async () => [] },
      epochs: { get: async () => null },
    },
    progressOwnedCarrier: async () => {},
    mcpDistDir: '/unused',
    allowedDirectories: [],
    publish() {},
  });
  const login = await app.inject({ url: '/api/session' });
  const headers = { cookie: String(login.headers['set-cookie']).split(';')[0]!, origin: 'http://localhost:5102' };
  t.after(async () => {
    await app.close();
    await sessions.close();
    if (priorOwner === undefined) delete process.env.DEFAULT_OWNER_USER_ID;
    else process.env.DEFAULT_OWNER_USER_ID = priorOwner;
  });
  return {
    companion,
    owner,
    carrier,
    allocations,
    request: (expectedDutyCatProfileId?: string) =>
      app.inject({
        method: 'POST',
        url: '/api/concierge/live',
        headers,
        payload: { allowHomeReads: false, ...(expectedDutyCatProfileId ? { expectedDutyCatProfileId } : {}) },
      }),
  };
}

test('a retired saved choice is never prepared: it reads as the roster default, and the old expected choice is refused', async (t) => {
  const f = await fixture(t);
  f.companion.set({ dutyCatProfileId: 'retired-choice' });
  const modern = await f.request('retired-choice');
  assert.equal(modern.statusCode, 409);
  assert.equal(modern.json().code, 'live_duty_unavailable');
  assert.deepEqual(f.allocations, []);
  const fallback = (await f.companion.read()).dutyCatProfileId;
  assert.notEqual(fallback, 'retired-choice');
  assert.equal((await f.request()).statusCode, 503, 'the roster default reaches the existing prepare seam');
  assert.deepEqual(f.allocations, [fallback]);
});

test('modern prepare admits only the saved choice it read, and a changed choice never silently selects another cat', async (t) => {
  const f = await fixture(t);
  f.companion.set({ dutyCatProfileId: f.carrier.id });
  assert.equal((await f.request(f.carrier.id)).statusCode, 503, 'the actual selected identity reaches prepare');
  assert.deepEqual(f.allocations, [f.carrier.id]);
  assert.equal((await f.request('previous-choice')).statusCode, 409);
  assert.deepEqual(f.allocations, [f.carrier.id]);
});
