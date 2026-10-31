import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { type TestContext, test } from 'node:test';
import { CONCIERGE_CONFIG_DEFAULTS, createCatId } from '@cat-cafe/shared';
import { validateCompanionReply } from '@clowder-ai/plugin-contract-beta27';
import { createCompanionClient } from '@clowder-ai/plugin-sdk-beta23/companion';
import cookie from '@fastify/cookie';
import Fastify from 'fastify';
import { MessageStore } from '../src/domains/cats/services/stores/ports/MessageStore.js';
import { CompanionHostBridge } from '../src/domains/concierge/live/CompanionHostBridge.js';
import { LivePresentationObservations } from '../src/domains/concierge/live/live-presentation-observations.js';
import { sessionAuthPlugin, sessionRoute } from '../src/infrastructure/session-auth.js';

async function fixture(t: TestContext) {
  const previousOwner = process.env.DEFAULT_OWNER_USER_ID;
  process.env.DEFAULT_OWNER_USER_ID = 'presentation-owner';
  const app = Fastify();
  await app.register(cookie);
  await app.register(sessionAuthPlugin);
  await app.register(sessionRoute, { ownerUserId: 'presentation-owner' });
  const callId = randomUUID();
  app.get('/api/concierge/config', async () => ({
    status: 'available',
    config: { ...CONCIERGE_CONFIG_DEFAULTS, dutyCatProfileId: 'codex', ballSize: 43 },
    companions: [{ catProfileId: 'codex', displayName: 'Fixture', available: true }],
    selectedCompanionStatus: 'available',
  }));
  app.post('/api/concierge/live', async () => ({ callId, state: 'ready' }));
  app.get('/api/concierge/live/:id', async () => ({
    callId,
    catId: 'codex',
    state: 'ready',
    toolsReady: true,
    nativeActivity: 'none',
    nativeWork: { scopeId: null, revision: 0, active: [], recent: [] },
  }));
  app.post('/api/concierge/live/:id/stop', async () => ({ stopped: true }));
  const store = new MessageStore();
  let current = true;
  let holdRead: Promise<void> | undefined;
  const facts: string[] = [];
  const port = new LivePresentationObservations({
    scope: { userId: 'presentation-owner', threadId: 'home', catId: 'codex', callId },
    session: () => 'rtc',
    available: () => true,
    verify: async () => true,
    store: {
      getById: async (id) => {
        await holdRead;
        return store.getById(id);
      },
    },
    observed: (_receipt, itemId) => {
      facts.push(itemId);
    },
  });
  const bridge = new CompanionHostBridge({
    app,
    ownerUserId: 'presentation-owner',
    origin: 'http://localhost:5102',
    publicCompanionV2: true,
    companionContract: '0.1.0-beta.27',
    assertCurrent: async () => {
      if (!current) throw new Error('fixture lease revoked');
    },
    openConversation: async () => true,
    observePresentation: (receipt, verifyHost) => port.observe(receipt, verifyHost),
  });
  const client = createCompanionClient({
    request: async (command) => {
      const reply = await bridge.request(command);
      assert.ok(validateCompanionReply(reply));
      return reply;
    },
    subscribe: () => () => {},
  });
  t.after(async () => {
    port.close();
    await bridge.close();
    await app.close();
    if (previousOwner === undefined) delete process.env.DEFAULT_OWNER_USER_ID;
    else process.env.DEFAULT_OWNER_USER_ID = previousOwner;
  });
  const receipt = (reference = { kind: 'native-item' as const, nativeItemId: 'item' }) => ({
    event: 'first_text_visible' as const,
    observedAt: Date.now(),
    callId,
    reference,
  });
  const append = (userId = 'presentation-owner') =>
    store.append({
      userId,
      threadId: 'home',
      from: { kind: 'agent', catId: createCatId('codex') },
      mentions: [],
      content: 'Fixture answer',
      timestamp: Date.now(),
      extra: {
        liveCompanion: {
          modality: 'voice',
          callId,
          nativeThreadId: 'root',
          realtimeSessionId: 'rtc',
          nativeItemId: 'item',
        },
      },
    });
  return {
    app,
    bridge,
    client,
    port,
    store,
    facts,
    receipt,
    append,
    hold: (read: Promise<void>) => {
      holdRead = read;
    },
    revoke: () => {
      current = false;
    },
  };
}

test('installed beta.23 SDK reaches beta.27 HostBridge and records native/message aliases once', async (t) => {
  const f = await fixture(t);
  const state = await f.client.prepare();
  assert.equal(state.phase, 'ready');
  assert.equal(state.meeting.kind, 'unconfirmed', 'missing trusted meeting evidence stays unknown');
  const settings = await f.client.readSettings();
  assert.equal(settings.status, 'available');
  if (settings.status === 'available') assert.equal(settings.values.ballSize, 43);
  await assert.rejects(f.client.observePresentation(f.receipt()), { code: 'unavailable' });
  f.port.outward({
    stage: 'first_outward_text',
    observedAt: Date.now(),
    callId: state.phase === 'ready' ? f.receipt().callId : '',
    eventId: 'publish',
    nativeItemId: 'item',
  });
  assert.deepEqual(await f.client.observePresentation(f.receipt()), { kind: 'ok' });
  const message = f.append();
  assert.deepEqual(
    await f.client.observePresentation({ ...f.receipt(), reference: { kind: 'message', messageId: message.id } }),
    { kind: 'ok' },
  );
  assert.deepEqual(f.facts, ['item']);
  const foreign = f.append('foreign');
  await assert.rejects(
    f.client.observePresentation({ ...f.receipt(), reference: { kind: 'message', messageId: foreign.id } }),
    { code: 'invalid_request' },
  );
  assert.deepEqual(
    await f.bridge.request({ ...f.receipt(), kind: 'presentation.observe', realtimeSessionId: 'forged' }),
    { kind: 'error', code: 'invalid_request' },
  );
  await f.client.stop();
  await assert.rejects(f.client.observePresentation(f.receipt()), { code: 'invalid_request' });
  assert.deepEqual(f.facts, ['item']);
});

test('Host stop during a message lookup prevents a stale visibility fact before Live teardown completes', async (t) => {
  const f = await fixture(t);
  await f.client.prepare();
  const message = f.append();
  let release!: () => void;
  f.hold(
    new Promise<void>((resolve) => {
      release = resolve;
    }),
  );
  const observing = f.client.observePresentation({
    ...f.receipt(),
    reference: { kind: 'message', messageId: message.id },
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  await f.client.stop();
  release();
  await assert.rejects(observing);
  assert.deepEqual(f.facts, []);
});

test('revoked Host authority is a permanent refusal and cannot record a public visibility fact', async (t) => {
  const f = await fixture(t);
  await f.client.prepare();
  const message = f.append();
  f.revoke();
  await assert.rejects(
    f.client.observePresentation({ ...f.receipt(), reference: { kind: 'message', messageId: message.id } }),
    { code: 'invalid_request' },
  );
  assert.deepEqual(f.facts, []);
});
