import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import { CONCIERGE_CONFIG_DEFAULTS } from '@cat-cafe/shared';
import cookie from '@fastify/cookie';
import Fastify from 'fastify';
import { ThreadStore } from '../dist/domains/cats/services/stores/ports/ThreadStore.js';
import { MemoryConciergeConfigStore } from '../dist/domains/concierge/ConciergeConfigStore.js';
import { ConciergeThreadService } from '../dist/domains/concierge/ConciergeThreadService.js';
import { CompanionHostBridge } from '../dist/domains/concierge/live/CompanionHostBridge.js';
import { CompanionAppAssistOwner } from '../dist/domains/concierge/live/host/companion-app-assist-owner.js';
import {
  appAssistReplyValidator,
  companionCommandValidator,
} from '../dist/domains/plugin/desktop-window-runtime/admission.js';
import { sessionAuthPlugin, sessionRoute } from '../dist/infrastructure/session-auth.js';
import { conciergeRoutes } from '../dist/routes/concierge.js';

const require = createRequire(import.meta.url);
const { createManagedWindow } = require('../../../desktop/plugin-window/window.cjs');
const { createAppAssistHost } = require('../../../desktop/plugin-window/app-assist-host.cjs');
const { fixture, input } = require('../../../desktop/plugin-window/window-motion-fixture.cjs');

test('the exact new public pair exposes the original independent owner setting while keeping the offer in the desktop Host', async (t) => {
  const owner = 'fixture-app-assist-public-owner';
  const previous = process.env.DEFAULT_OWNER_USER_ID;
  process.env.DEFAULT_OWNER_USER_ID = owner;
  const app = Fastify(),
    store = new MemoryConciergeConfigStore();
  t.after(async () => {
    await app.close();
    if (previous === undefined) delete process.env.DEFAULT_OWNER_USER_ID;
    else process.env.DEFAULT_OWNER_USER_ID = previous;
  });
  await store.put(owner, { ...CONCIERGE_CONFIG_DEFAULTS, dutyCatProfileId: 'opus' });
  await app.register(cookie);
  await app.register(sessionAuthPlugin);
  await app.register(sessionRoute, { ownerUserId: owner });
  await app.register(conciergeRoutes, {
    conciergeConfigStore: store,
    conciergeThreadService: new ConciergeThreadService({ conciergeConfigStore: store, threadStore: new ThreadStore() }),
  });
  const port = { request: async () => ({ status: 'off' }), watch: async () => async () => {} };
  const options = {
    app,
    ownerUserId: owner,
    origin: 'http://localhost:5102',
    assertCurrent: async () => {},
    publicCompanionV2: true,
    openConversation: async () => true,
    appAssist: port,
  };
  const current = new CompanionHostBridge({ ...options, companionContract: '0.1.0-beta.29' });
  const older = new CompanionHostBridge({ ...options, companionContract: '0.1.0-beta.28' });
  const read = await current.request({ kind: 'settings.read' });
  assert.equal(read.kind, 'settings');
  assert.equal(read.values.appAssistEnabled, false);
  const saved = await current.request({ kind: 'settings.update', field: 'appAssistEnabled', value: true });
  assert.equal(saved.outcome, 'saved');
  assert.equal(saved.callStatus, 'unchanged');
  assert.equal((await store.getSaved(owner)).appAssistEnabled, true);
  assert.equal(current.appAssist, port);
  assert.equal(older.appAssist, undefined);
  const state = await current.request({ kind: 'state' });
  assert.equal(state.kind, 'state');
  assert.equal(Object.hasOwn(state, 'appAssist'), false, 'the API has no second transient offer owner');
  assert.equal(Object.hasOwn((await older.request({ kind: 'settings.read' })).values, 'appAssistEnabled'), false);
  assert.deepEqual(await older.request({ kind: 'settings.update', field: 'appAssistEnabled', value: true }), {
    kind: 'error',
    code: 'invalid_request',
  });
  assert.deepEqual(
    await current.request({
      kind: 'app-assist.settle',
      scopeRef: 'fixture-scope',
      offerRef: 'fixture-offer',
      action: 'accept',
    }),
    { kind: 'error', code: 'invalid_request' },
  );

  // Validate the complete public reply at its real owner boundary: private API
  // base -> actual window decoration -> actual Host -> published validator.
  const native = fixture();
  const internalOwner = new CompanionAppAssistOwner({
    store,
    ownerUserId: owner,
    timeZone: () => 'Pacific/Honolulu',
    now: () => Date.parse('2030-01-02T12:00:00Z'),
    assertCurrent: async () => {},
  });
  let observe;
  const host = createAppAssistHost({
    owner: {
      read: () => internalOwner.request({ kind: 'read' }),
      claim: (appKey) => internalOwner.request({ kind: 'claim', appKey }),
    },
    selfBundleIds: ['ai.fixture.self'],
    sourceFactory: async (onEvent) => {
      observe = onEvent;
      return { close: async () => {} };
    },
    validateReply: appAssistReplyValidator('0.1.0-beta.29'),
  });
  const unwatch = await internalOwner.watch((allowed) => host.policyChanged(allowed));
  const managed = await createManagedWindow(
    native.electron,
    { ...input, publicCompanionV2: true, companionContract: '0.1.0-beta.29' },
    {
      appAssist: host,
      validate: companionCommandValidator('0.1.0-beta.29'),
      request: (command) => current.request(command),
    },
  );
  t.after(async () => {
    managed.close();
    await host.close();
    await unwatch();
  });
  await observe({ bundleId: 'org.fixture.public-composition', name: 'Fixture Editor' });
  const complete = await native.request({ kind: 'state' });
  assert.equal(complete.kind, 'state');
  assert.equal(complete.appAssist.offer.appName, 'Fixture Editor');
  assert.equal(appAssistReplyValidator('0.1.0-beta.29')(complete), true);
  const settled = await native.request({
    kind: 'app-assist.settle',
    scopeRef: complete.appAssist.scopeRef,
    offerRef: complete.appAssist.offer.offerRef,
    action: 'accept',
  });
  assert.equal(settled.outcome, 'settled');
  assert.equal((await native.request({ kind: 'state' })).appAssist.offer, null);
});
