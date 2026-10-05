import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { CONCIERGE_CONFIG_DEFAULTS, catRegistry } from '@cat-cafe/shared';
import cookie from '@fastify/cookie';
import Fastify from 'fastify';
import { getRoster, loadCatConfig, toAllCatConfigs } from '../src/config/cat-config-loader.js';
import type { StoredMessage } from '../src/domains/cats/services/stores/ports/MessageStore.js';
import { CompanionHostBridge } from '../src/domains/concierge/live/CompanionHostBridge.js';
import { projectLiveTranscript } from '../src/domains/concierge/live/live-transcript-projection.js';
import { sessionAuthPlugin, sessionRoute } from '../src/infrastructure/session-auth.js';

async function fixture() {
  const owner = 'modern-live-owner';
  const priorOwner = process.env.DEFAULT_OWNER_USER_ID;
  process.env.DEFAULT_OWNER_USER_ID = owner;
  const template = loadCatConfig(process.env.CAT_TEMPLATE_PATH);
  getRoster(template);
  const cats = Object.values(toAllCatConfigs(template));
  for (const cat of cats) if (!catRegistry.has(cat.id)) catRegistry.register(cat.id, cat);
  const carrier = cats.find((cat) => cat.clientId === 'openai' && cat.provider !== 'openai-chatgpt-pro');
  assert.ok(carrier);
  const app = Fastify();
  await app.register(cookie);
  await app.register(sessionAuthPlugin);
  await app.register(sessionRoute, { ownerUserId: owner });
  const callId = randomUUID();
  const clientMessageId = randomUUID();
  const scope = { callId, realtimeSessionId: 'realtime-current' };
  const threadId = 'conversation-current';
  let selectedCompanionStatus = 'available';
  let prepares = 0;
  const source = {
    callId,
    modality: 'voice' as const,
    role: 'assistant' as const,
    nativeThreadId: 'native-current',
    realtimeSessionId: scope.realtimeSessionId,
    nativeItemId: 'item-a',
  };
  const row = (id: string, extra: StoredMessage['extra'], catId: StoredMessage['catId']): StoredMessage => ({
    id,
    userId: owner,
    threadId,
    catId,
    content: id,
    mentions: [],
    timestamp: 1,
    extra,
  });
  const rows = [
    row('voice-a', { liveCompanion: source }, carrier.id),
    row('typed-a', { liveCompanion: { callId, modality: 'typed', role: 'user', clientMessageId } }, null),
    row('result-a', { liveCompanion: { ...source, modality: 'result' } }, carrier.id),
    row('old-call-a', { liveCompanion: { ...source, callId: randomUUID() } }, carrier.id),
  ];
  app.get('/api/concierge/config', async (request) => ({
    config: { ...CONCIERGE_CONFIG_DEFAULTS, dutyCatProfileId: carrier.id },
    behaviorEnabled: true,
    ...((request.query as { view?: string }).view === 'settings'
      ? {
          status: 'available',
          selectedCompanionStatus,
          companions: [{ catProfileId: carrier.id, displayName: carrier.displayName, available: true }],
        }
      : {}),
  }));
  app.post('/api/concierge/thread', async () => ({ threadId }));
  app.post('/api/concierge/live', async () => {
    prepares++;
    return { callId };
  });
  app.get('/api/concierge/live/:id', async () => ({
    callId,
    state: 'ready',
    catId: carrier.id,
    toolsReady: false,
    nativeActivity: 'none',
    nativeWork: { scopeId: null, revision: 0, active: [], recent: [] },
  }));
  app.get('/api/concierge/live/:id/transcript', async () => ({
    kind: 'transcript',
    scope,
    ...projectLiveTranscript(rows, { userId: owner, threadId, callId }),
  }));
  app.post('/api/concierge/live/:id/text', async () => ({ messageId: 'saved-live-text', delivery: 'accepted' }));
  app.post('/api/messages', async () => ({ status: 'queued', userMessageId: 'saved-ordinary-text' }));
  const bridge = new CompanionHostBridge({
    app,
    ownerUserId: owner,
    origin: 'http://localhost:5102',
    assertCurrent: async () => {},
    publicCompanionV2: true,
    companionContract: '0.1.0-beta.23',
    openConversation: async () => true,
  });
  return {
    bridge,
    callId,
    clientMessageId,
    scope,
    unavailableSelection: () => {
      selectedCompanionStatus = 'unavailable';
    },
    prepares: () => prepares,
    cleanup: async () => {
      await app.close();
      if (priorOwner === undefined) delete process.env.DEFAULT_OWNER_USER_ID;
      else process.env.DEFAULT_OWNER_USER_ID = priorOwner;
    },
  };
}

test('modern transcript keeps the owned scope and stable typed/voice sources; result and another call remain outside', async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  assert.equal((await f.bridge.request({ kind: 'prepare' })).kind, 'state');
  const transcript = await f.bridge.request({ kind: 'transcript.read' });
  assert.equal(transcript.kind, 'transcript');
  if (transcript.kind !== 'transcript') assert.fail('current transcript unavailable');
  assert.deepEqual(transcript.scope, f.scope);
  assert.deepEqual(
    transcript.rows.map((row) => row.messageId),
    ['voice-a', 'typed-a'],
  );
  assert.equal(transcript.rows[0]!.source.kind, 'voice');
  assert.equal('callId' in transcript.rows[0]!.source, false);
  assert.deepEqual(transcript.rows[1]!.source, { kind: 'typed', callId: f.callId, clientMessageId: f.clientMessageId });
});

test('modern state and prepare refuse an unavailable saved identity instead of presenting the effective legacy fallback', async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  f.unavailableSelection();
  assert.deepEqual(await f.bridge.request({ kind: 'state' }), { kind: 'error', code: 'carrier_unavailable' });
  assert.deepEqual(await f.bridge.request({ kind: 'prepare' }), { kind: 'error', code: 'carrier_unavailable' });
  assert.equal(f.prepares(), 0);
});

test('modern typed delivery retains send/message identity and distinguishes a live call from ordinary chat', async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  const command = { kind: 'text', text: 'hello', clientMessageId: f.clientMessageId };
  assert.deepEqual(await f.bridge.request(command), {
    kind: 'delivery',
    delivery: 'accepted',
    clientMessageId: f.clientMessageId,
    messageId: 'saved-ordinary-text',
    callId: null,
  });
  await f.bridge.request({ kind: 'prepare' });
  assert.deepEqual(await f.bridge.request(command), {
    kind: 'delivery',
    delivery: 'accepted',
    clientMessageId: f.clientMessageId,
    messageId: 'saved-live-text',
    callId: f.callId,
  });
});
