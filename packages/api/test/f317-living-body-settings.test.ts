import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type CatConfig, CONCIERGE_CONFIG_DEFAULTS, catRegistry } from '@cat-cafe/shared';
import cookie from '@fastify/cookie';
import Fastify from 'fastify';
import { MessageStore } from '../src/domains/cats/services/stores/ports/MessageStore.js';
import { ThreadStore } from '../src/domains/cats/services/stores/ports/ThreadStore.js';
import { MemoryConciergeConfigStore } from '../src/domains/concierge/ConciergeConfigStore.js';
import { MemoryConciergeConfirmationStore } from '../src/domains/concierge/ConciergeConfirmationStore.js';
import { MemoryConciergeRelayStore } from '../src/domains/concierge/ConciergeRelayStore.js';
import { ConciergeThreadService } from '../src/domains/concierge/ConciergeThreadService.js';
import { CompanionHostBridge } from '../src/domains/concierge/live/CompanionHostBridge.js';
import type { CompanionContract } from '../src/domains/plugin/desktop-window-runtime/published-companion-v2.js';
import { sessionAuthPlugin, sessionRoute } from '../src/infrastructure/session-auth.js';
import { conciergeRoutes } from '../src/routes/concierge.js';

// F336 Phase C U8, Host side: the living cat's skin is saved like any other, read as itself only on the
// livingBody line, and projected to the cat an older line already draws; the saved choice is never rewritten.
const OWNER = 'living-settings-owner';

// The duty cat is registered here (a native carrier itself), so the settings read does not depend on the
// roster of whatever environment runs the test; the previous roster is restored on cleanup.
function dutyCat(id: string): CatConfig {
  return {
    id,
    name: id,
    displayName: '布偶猫',
    avatar: '',
    color: { primary: '#000', secondary: '#fff' },
    mentionPatterns: [`@${id}`],
    clientId: 'openai',
    defaultModel: 'model',
    mcpSupport: true,
    roleDescription: 'test',
    personality: 'test',
  } as unknown as CatConfig;
}

async function fixture() {
  const savedRoster = { ...catRegistry.getAllConfigs() };
  if (!catRegistry.has('opus')) catRegistry.register('opus', dutyCat('opus'));
  const previousOwner = process.env.DEFAULT_OWNER_USER_ID;
  process.env.DEFAULT_OWNER_USER_ID = OWNER;
  const app = Fastify();
  const store = new MemoryConciergeConfigStore();
  await store.put(OWNER, { ...CONCIERGE_CONFIG_DEFAULTS, dutyCatProfileId: 'opus' });
  await app.register(cookie);
  await app.register(sessionAuthPlugin);
  await app.register(sessionRoute, { ownerUserId: OWNER });
  await app.register(conciergeRoutes, {
    conciergeConfigStore: store,
    conciergeThreadService: new ConciergeThreadService({ conciergeConfigStore: store, threadStore: new ThreadStore() }),
    conciergeRelayStore: new MemoryConciergeRelayStore(),
    conciergeConfirmationStore: new MemoryConciergeConfirmationStore(),
    messageStore: new MessageStore(),
  });
  const bridge = (companionContract?: CompanionContract) =>
    new CompanionHostBridge({
      app,
      ownerUserId: OWNER,
      origin: 'http://localhost:5102',
      assertCurrent: async () => {},
      publicCompanionV2: true,
      openConversation: async () => true,
      ...(companionContract ? { companionContract } : {}),
    });
  return {
    app,
    store,
    bridge,
    cleanup: async () => {
      await app.close();
      catRegistry.reset();
      for (const [id, config] of Object.entries(savedRoster)) catRegistry.register(id, config);
      if (previousOwner === undefined) delete process.env.DEFAULT_OWNER_USER_ID;
      else process.env.DEFAULT_OWNER_USER_ID = previousOwner;
    },
  };
}

test('the living skin saves through the owner route on the livingBody line; older lines cannot send it', async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  const update = { kind: 'settings.update', field: 'skin', value: 'xianxian-living' } as const;
  const saved = await f.bridge('0.3.3-candidate.3').request(update);
  assert.equal(saved.kind === 'settings-update' && saved.outcome, 'saved');
  assert.equal((await f.store.getSaved(OWNER)).skin, 'xianxian-living');
  assert.deepEqual(await f.bridge('0.3.3-candidate.0').request(update), { kind: 'error', code: 'invalid_request' });
  const refused = await f.app.inject({
    method: 'PUT',
    url: '/api/concierge/config',
    headers: { 'x-cat-cafe-user': OWNER },
    payload: { skin: 'xianxian-dead' },
  });
  assert.equal(refused.statusCode, 400, 'the route still validates the closed skin list');
});

test('new Host + old package: older lines read xianxian-codex, the saved living choice is kept', async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  await f.store.put(OWNER, { ...CONCIERGE_CONFIG_DEFAULTS, dutyCatProfileId: 'opus', skin: 'xianxian-living' });
  for (const contract of ['0.1.0-beta.23', '0.1.0-beta.25', '0.1.0-beta.29', '0.3.3-candidate.0'] as const) {
    const bridge = f.bridge(contract);
    const read = await bridge.request({ kind: 'settings.read' });
    if (read.kind !== 'settings' || read.status !== 'available') assert.fail(`${contract} settings must stay readable`);
    assert.equal(read.values.skin, 'xianxian-codex', contract);
    const state = await bridge.request({ kind: 'state' });
    assert.equal(state.kind === 'state' && state.skin, 'xianxian-codex', `${contract} ${JSON.stringify(state)}`);
  }
  const legacy = await f.bridge().request({ kind: 'state' });
  assert.equal(legacy.kind === 'state' && legacy.skin, 'xianxian-codex', 'beta.21 state too');
  const living = f.bridge('0.3.3-candidate.3');
  const read = await living.request({ kind: 'settings.read' });
  assert.equal(read.kind === 'settings' && read.status === 'available' && read.values.skin, 'xianxian-living');
  const state = await living.request({ kind: 'state' });
  assert.equal(state.kind === 'state' && state.skin, 'xianxian-living');
  assert.equal((await f.store.getSaved(OWNER)).skin, 'xianxian-living', 'no read rewrote the choice');
});
