import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { type TestContext, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { CONCIERGE_CONFIG_DEFAULTS, catRegistry } from '@cat-cafe/shared';
import { validateCompanionReply } from '@clowder-ai/plugin-contract';
import { validateCompanionReply as validateBeta20Reply } from '@clowder-ai/plugin-contract-beta20';
import cookie from '@fastify/cookie';
import Fastify from 'fastify';
import { getRoster, loadCatConfig, toAllCatConfigs } from '../src/config/cat-config-loader.js';
import { MessageStore } from '../src/domains/cats/services/stores/ports/MessageStore.js';
import { ThreadStore } from '../src/domains/cats/services/stores/ports/ThreadStore.js';
import { MemoryConciergeConfigStore } from '../src/domains/concierge/ConciergeConfigStore.js';
import { MemoryConciergeConfirmationStore } from '../src/domains/concierge/ConciergeConfirmationStore.js';
import { MemoryConciergeRelayStore } from '../src/domains/concierge/ConciergeRelayStore.js';
import { ConciergeThreadService } from '../src/domains/concierge/ConciergeThreadService.js';
import { CompanionHostBridge } from '../src/domains/concierge/live/CompanionHostBridge.js';
import { LiveCompanionSessions } from '../src/domains/concierge/live/LiveCompanionSessions.js';
import { createLiveConfigChange } from '../src/domains/concierge/live/live-config-transition.js';
import { validateHostCompanionReply } from '../src/domains/plugin/desktop-window-runtime/companion-private-wire.js';
import { sessionAuthPlugin, sessionRoute } from '../src/infrastructure/session-auth.js';
import { conciergeRoutes } from '../src/routes/concierge.js';
import { createIsolatedTemplateRoot } from './helpers/isolated-template-root.js';

const require = createRequire(import.meta.url);
const { fixture: windowFixture, input } = require('../../../desktop/plugin-window/window-motion-fixture.cjs');
const { createManagedWindow } = require('../../../desktop/plugin-window/window.cjs');

async function fixture(t: TestContext, includeFenceRead = true) {
  const isolated = createIsolatedTemplateRoot(
    process.env.TMPDIR ?? '/tmp',
    fileURLToPath(new URL('../../../cat-template.json', import.meta.url)),
  );
  t.after(isolated.cleanup);
  const template = loadCatConfig(isolated.templatePath);
  const cats = Object.values(toAllCatConfigs(template));
  for (const cat of cats) if (!catRegistry.has(cat.id)) catRegistry.register(cat.id, cat);
  getRoster(template);
  const carrier = cats.find((cat) => cat.clientId === 'openai' && cat.provider !== 'openai-chatgpt-pro');
  assert.ok(carrier);
  const owner = 'native-preference-owner';
  const oldOwner = process.env.DEFAULT_OWNER_USER_ID;
  process.env.DEFAULT_OWNER_USER_ID = owner;
  const app = Fastify();
  const store = new MemoryConciergeConfigStore();
  const sessions = new LiveCompanionSessions();
  await store.put(owner, { ...CONCIERGE_CONFIG_DEFAULTS, dutyCatProfileId: carrier.id, behaviorEnabled: true });
  await app.register(cookie);
  await app.register(sessionAuthPlugin);
  await app.register(sessionRoute, { ownerUserId: owner });
  await app.register(conciergeRoutes, {
    conciergeConfigStore: store,
    conciergeThreadService: new ConciergeThreadService({ conciergeConfigStore: store, threadStore: new ThreadStore() }),
    conciergeRelayStore: new MemoryConciergeRelayStore(),
    conciergeConfirmationStore: new MemoryConciergeConfirmationStore(),
    messageStore: new MessageStore(),
    withLiveConfigChange: createLiveConfigChange({ store, sessions, ownerUserId: owner, revokeMedia: async () => {} }),
    ...(includeFenceRead
      ? { isLiveConfigChangePending: (userId: string) => sessions.isChangingPreferences(userId) }
      : {}),
    configWriteTimeoutMs: 20,
  });
  const callId = randomUUID();
  app.post('/api/concierge/live', async (_request, reply) => reply.code(202).send({ callId }));
  app.get('/api/concierge/live/:id', async () => ({
    state: 'ready',
    catId: carrier.id,
    toolsReady: false,
    nativeActivity: 'none',
    nativeWork: { scopeId: null, revision: 0, active: [], recent: [] },
  }));
  app.delete('/api/concierge/live/:id', async () => ({ stopped: true }));
  const bridge = new CompanionHostBridge({
    app,
    ownerUserId: owner,
    origin: 'http://localhost:5102',
    publicCompanionV2: true,
    assertCurrent: async () => {},
    openConversation: async () => false,
  });
  t.after(async () => {
    await bridge.close();
    await sessions.close();
    await app.close();
    if (oldOwner === undefined) delete process.env.DEFAULT_OWNER_USER_ID;
    else process.env.DEFAULT_OWNER_USER_ID = oldOwner;
  });
  const f = windowFixture();
  const managed = await createManagedWindow(f.electron, input, {
    validate: () => true,
    request: (command: unknown) => bridge.request(command),
  });
  t.after(() => managed.close());
  return { app, store, owner, bridge, f, managed };
}

test('actual Host state drives persisted native movement while the alpha.13 renderer keeps beta.21/20 replies', async (t) => {
  const f = await fixture(t);
  const privateState = await f.bridge.request({ kind: 'state' });
  assert.equal(privateState.kind, 'state');
  assert.equal('behaviorEnabled' in privateState && privateState.behaviorEnabled, true);
  assert.equal(validateHostCompanionReply(privateState), true);
  assert.equal(validateHostCompanionReply({ ...privateState, behaviorEnabled: 'true' }), false);
  assert.equal(validateHostCompanionReply({ ...privateState, unexpectedPolicy: true }), false);
  const publicState = await f.f.request({ kind: 'state' });
  assert.ok(f.managed.motionLease(), 'production Bridge output, rather than fixture-invented flags, admits movement');
  assert.equal(validateCompanionReply(publicState), true);
  assert.equal(validateBeta20Reply(publicState), true);
  assert.equal('behaviorEnabled' in publicState, false, 'Host-only policy must not change the old renderer schema');
  assert.equal(
    (await f.f.request({ kind: 'screen.pick' }, true)).code,
    'permission_required',
    'movement never prepares media',
  );
  await f.f.request({ kind: 'prepare' }, true);
  assert.ok(f.managed.motionLease());
  const config = await f.store.getSaved(f.owner);
  await f.store.put(f.owner, { ...config, behaviorEnabled: false });
  await f.f.request({ kind: 'state' });
  assert.equal(f.managed.motionLease(), null);
});

test('a configured write transition without its status reader cannot prove native movement admission', async (t) => {
  const f = await fixture(t, false);
  assert.equal((await f.store.getSaved(f.owner)).behaviorEnabled, true);
  await f.f.request({ kind: 'state' });
  assert.equal(f.managed.motionLease(), null);
});

test('a saved record predating the behavior preference uses the same default as the Web projection', async (t) => {
  const f = await fixture(t);
  const legacy = await f.store.getSaved(f.owner);
  delete legacy.behaviorEnabled;
  await f.store.put(f.owner, legacy);
  const login = await f.app.inject({ url: '/api/session' });
  const headers = { cookie: String(login.headers['set-cookie']).split(';')[0]!, origin: 'http://localhost:5102' };
  const ordinary = (await f.app.inject({ url: '/api/concierge/config', headers })).json().config;
  assert.equal(ordinary.behaviorEnabled, undefined);
  const native = await f.app.inject({ url: '/api/concierge/config?view=native', headers });
  assert.equal(native.statusCode, 200);
  assert.equal(native.json().behaviorEnabled, ordinary.behaviorEnabled ?? true);
  const state = await f.bridge.request({ kind: 'state' });
  assert.equal('behaviorEnabled' in state && state.behaviorEnabled, true);
  await f.f.request({ kind: 'state' });
  assert.ok(f.managed.motionLease());
  assert.equal(
    (await f.store.getSaved(f.owner)).behaviorEnabled,
    undefined,
    'reading a default does not backfill storage',
  );
});

test('an unconfirmed write cannot re-arm native movement from its old persisted value', async (t) => {
  const f = await fixture(t);
  await f.f.request({ kind: 'state' });
  assert.ok(f.managed.motionLease());
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  t.after(release);
  const put = f.store.put.bind(f.store);
  f.store.put = async (owner, config) => {
    await pending;
    await put(owner, config);
  };
  const login = await f.app.inject({ url: '/api/session' });
  const headers = { cookie: String(login.headers['set-cookie']).split(';')[0]!, origin: 'http://localhost:5102' };
  const response = await f.app.inject({
    method: 'PUT',
    url: '/api/concierge/config',
    headers,
    payload: { behaviorEnabled: false },
  });
  assert.equal(response.statusCode, 503);
  assert.equal(response.json().code, 'configuration_write_unconfirmed');
  assert.equal((await f.store.getSaved(f.owner)).behaviorEnabled, true, 'the old record is still present');
  await f.f.request({ kind: 'state' });
  assert.equal(
    f.managed.motionLease(),
    null,
    'the actual Host producer fences pending writes even after the RPC receipt',
  );
  release();
  await new Promise((resolve) => setImmediate(resolve));
  await f.f.request({ kind: 'state' });
  assert.equal(f.managed.motionLease(), null);
  assert.equal((await f.store.getSaved(f.owner)).behaviorEnabled, false);
});
