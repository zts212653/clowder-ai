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
import { CompanionHostBridge } from '../src/domains/concierge/live/CompanionHostBridge.js';
import { LiveCompanionSessions } from '../src/domains/concierge/live/LiveCompanionSessions.js';
import { createLiveConfigChange } from '../src/domains/concierge/live/live-config-transition.js';
import { sessionAuthPlugin, sessionRoute } from '../src/infrastructure/session-auth.js';
import { conciergeRoutes } from '../src/routes/concierge.js';

async function fixture() {
  const owner = 'modern-settings-owner';
  const previousOwner = process.env.DEFAULT_OWNER_USER_ID;
  process.env.DEFAULT_OWNER_USER_ID = owner;
  const app = Fastify();
  const store = new MemoryConciergeConfigStore();
  const sessions = new LiveCompanionSessions();
  const { behaviorEnabled: _absentInLegacy, ...legacy } = CONCIERGE_CONFIG_DEFAULTS;
  await store.put(owner, { ...legacy, dutyCatProfileId: 'retired-selected-profile' });
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
    isLiveConfigChangePending: (userId: string) => sessions.isChangingPreferences(userId),
    configWriteTimeoutMs: 20,
  });
  let mediaPreparations = 0;
  app.post('/api/concierge/live', async () => {
    mediaPreparations++;
    throw new Error('Settings must not prepare media');
  });
  const options = {
    app,
    ownerUserId: owner,
    origin: 'http://localhost:5102',
    assertCurrent: async () => {},
    publicCompanionV2: true,
    openConversation: async () => true,
  };
  return {
    modern: new CompanionHostBridge({ ...options, companionContract: '0.1.0-beta.23' }),
    legacy: new CompanionHostBridge(options),
    store,
    mediaPreparations: () => mediaPreparations,
    changing: () => sessions.isChangingPreferences(owner),
    cleanup: async () => {
      await sessions.close();
      await app.close();
      if (previousOwner === undefined) delete process.env.DEFAULT_OWNER_USER_ID;
      else process.env.DEFAULT_OWNER_USER_ID = previousOwner;
    },
  };
}

test('modern settings read fills canonical legacy defaults without rewriting the saved selection or record', async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  const read = await f.modern.request({ kind: 'settings.read' });
  assert.equal(read.kind, 'settings');
  if (read.kind !== 'settings' || read.status !== 'available') assert.fail('modern settings must be available');
  assert.equal(read.values.dutyCatProfileId, 'retired-selected-profile');
  assert.equal(read.values.behaviorEnabled, true);
  assert.equal(read.values.ballSize, 72);
  assert.equal(read.selectedCompanionStatus, 'unavailable');
  assert.equal((await f.store.getSaved('modern-settings-owner')).behaviorEnabled, undefined);
  assert.equal(f.mediaPreparations(), 0);
  assert.deepEqual(await f.legacy.request({ kind: 'settings.read' }), { kind: 'error', code: 'invalid_request' });
});

test(
  'a write timeout preserves the actual unconfirmed receipt and fence until its late settlement',
  { timeout: 1500 },
  async (t) => {
    const f = await fixture();
    t.after(f.cleanup);
    let finish!: () => void;
    let persisted!: () => void;
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const done = new Promise<void>((resolve) => {
      persisted = resolve;
    });
    const put = f.store.put.bind(f.store);
    f.store.put = async (userId, config) => {
      await gate;
      await put(userId, config);
      persisted();
    };
    try {
      assert.deepEqual(await f.modern.request({ kind: 'settings.update', field: 'behaviorEnabled', value: false }), {
        kind: 'settings-update',
        field: 'behaviorEnabled',
        outcome: 'unconfirmed',
        callStatus: 'unchanged',
        reconcile: 'settings.read',
      });
      assert.equal(f.changing(), true);
      assert.deepEqual(await f.modern.request({ kind: 'settings.update', field: 'skin', value: 'yarn-ball' }), {
        kind: 'error',
        code: 'busy',
      });
      finish();
      await done;
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(f.changing(), false);
      const read = await f.modern.request({ kind: 'settings.read' });
      if (read.kind !== 'settings' || read.status !== 'available') assert.fail('settled configuration is readable');
      assert.equal(read.values.behaviorEnabled, false);
      assert.equal(f.mediaPreparations(), 0);
    } finally {
      finish();
    }
  },
);

test('persona tone settles for the next call while source-read failure does not become a fake stop failure', async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  assert.deepEqual(await f.modern.request({ kind: 'settings.update', field: 'personaTone', value: '说话简短' }), {
    kind: 'settings-update',
    field: 'personaTone',
    outcome: 'saved',
    callStatus: 'unchanged',
    applies: 'next_call',
  });
  f.store.getSaved = async () => {
    throw new Error('source unavailable');
  };
  assert.deepEqual(await f.modern.request({ kind: 'settings.update', field: 'behaviorEnabled', value: false }), {
    kind: 'settings-update',
    field: 'behaviorEnabled',
    outcome: 'rejected',
    callStatus: 'unchanged',
    reason: 'save_failed',
  });
  assert.equal(f.mediaPreparations(), 0);
});

test('settings writes settle through the owner config route and refuse unavailable selections before writing', async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  assert.deepEqual(await f.modern.request({ kind: 'settings.update', field: 'behaviorEnabled', value: false }), {
    kind: 'settings-update',
    field: 'behaviorEnabled',
    outcome: 'saved',
    callStatus: 'unchanged',
    applies: 'now',
  });
  assert.equal((await f.store.getSaved('modern-settings-owner')).behaviorEnabled, false);
  assert.deepEqual(
    await f.modern.request({ kind: 'settings.update', field: 'dutyCatProfileId', value: 'missing-profile' }),
    {
      kind: 'settings-update',
      field: 'dutyCatProfileId',
      outcome: 'rejected',
      callStatus: 'unchanged',
      reason: 'selection_unavailable',
    },
  );
  assert.equal((await f.store.getSaved('modern-settings-owner')).dutyCatProfileId, 'retired-selected-profile');
  assert.equal(f.mediaPreparations(), 0);
});
