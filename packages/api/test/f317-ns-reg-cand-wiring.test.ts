// F317 north-star regression harness, Tier B bound to candidate d5d293aa2e: END-TO-END wiring.
// Real LiveCompanionCall (fake native only) -> real MessageStore -> the REAL conciergeLiveRoutes plugin
// with its own preHandler -> HTTP JSON. The author's route test calls registerLiveTranscriptRoutes directly;
// this proves the route is actually reachable through the plugin that ships. No media, no visible cat.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { CONCIERGE_CONFIG_DEFAULTS, createCatId } from '@cat-cafe/shared';
import cookie from '@fastify/cookie';
import Fastify from 'fastify';
import { MessageStore } from '../src/domains/cats/services/stores/ports/MessageStore.js';
import { ThreadStore } from '../src/domains/cats/services/stores/ports/ThreadStore.js';
import { MemoryConciergeConfigStore } from '../src/domains/concierge/ConciergeConfigStore.js';
import { ConciergeThreadService } from '../src/domains/concierge/ConciergeThreadService.js';
import { LiveCompanionSessions } from '../src/domains/concierge/live/LiveCompanionSessions.js';
import { sessionAuthPlugin, sessionRoute } from '../src/infrastructure/session-auth.js';
import { conciergeLiveRoutes } from '../src/routes/concierge-live.js';

const OWNER = 'default-user';

async function fixture() {
  const app = Fastify();
  const sessions = new LiveCompanionSessions();
  const threadStore = new ThreadStore();
  const messageStore = new MessageStore();
  const threadService = new ConciergeThreadService({ threadStore });
  const configStore = new MemoryConciergeConfigStore();
  await configStore.put(OWNER, { ...CONCIERGE_CONFIG_DEFAULTS, dutyCatProfileId: 'opus', displayName: '宪宪' });
  await app.register(cookie);
  await app.register(sessionAuthPlugin);
  await app.register(sessionRoute);
  await app.register(conciergeLiveRoutes, {
    ownerUserId: OWNER,
    configStore,
    sessions,
    threadService,
    messageStore,
    sessionChainStore: { getActive: async () => null },
    invocationQueue: {} as never,
    recovery: {} as never,
    progressOwnedCarrier: async () => ({}),
    mcpDistDir: resolve('../mcp-server/dist'),
    allowedDirectories: [resolve('../../docs')],
    publish() {},
  });
  const login = await app.inject({ method: 'GET', url: '/api/session' });
  const headers = { cookie: String(login.headers['set-cookie']).split(';')[0], origin: 'http://localhost:3011' };
  const threadId = await threadService.getOrCreate(OWNER);
  return {
    app,
    sessions,
    messageStore,
    threadId,
    headers,
    get: (callId: string, overrides: Record<string, unknown> = {}) =>
      app.inject({ method: 'GET', url: `/api/concierge/live/${callId}/transcript`, headers, ...overrides }),
    cleanup: async () => {
      await sessions.close();
      await app.close();
    },
  };
}

/** A prepared, talking call registered in the SAME sessions object the plugin reads. */
async function talkingCall(f: Awaited<ReturnType<typeof fixture>>, callId: string) {
  const call = await f.sessions.prepare({
    binding: { userId: OWNER, threadId: f.threadId, catId: createCatId('codex-astra'), callId },
    messageStore: f.messageStore,
    mcpDistDir: resolve('../mcp-server/dist'),
    allowedDirectories: [],
    verifyNativeBinding: async () => true,
    publish() {},
  });
  await call.ready('native', {
    submitText: async () => 'turn',
    request: async (method) => {
      if (method === 'thread/realtime/start') {
        await call.observe({
          method: 'thread/realtime/started',
          params: { threadId: 'native', realtimeSessionId: 'rtc' },
        });
        await call.observe({ method: 'thread/realtime/sdp', params: { threadId: 'native', sdp: 'answer' } });
      }
      if (method === 'thread/realtime/stop')
        await call.observe({ method: 'thread/realtime/closed', params: { threadId: 'native' } });
      return {};
    },
  });
  await call.start('offer');
  return call;
}
const speech = (role: 'user' | 'assistant', id: string, text: string) => ({
  method: 'thread/realtime/item/completed',
  params: { threadId: 'native', item: { id, realtimeSessionId: 'rtc', type: 'transcriptSegment', role, text } },
});

test('a real talking call: speech and typing reach the owner over HTTP through the shipped plugin, in order, with their sources', async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  const callId = randomUUID();
  const call = await talkingCall(f, callId);
  await call.observe(speech('user', 'u1', '你好'));
  const clientMessageId = randomUUID();
  await call.sendText('打字进来', clientMessageId);
  await call.observe(speech('assistant', 'a1', '我在这里'));

  const reply = await f.get(callId);
  assert.equal(reply.statusCode, 200, reply.body);
  const body = reply.json();
  assert.equal(body.kind, 'transcript');
  assert.equal(body.callId, callId);
  assert.equal(body.hasMore, false);
  assert.deepEqual(
    body.messages.map((m: { role: string; text: string; source: { kind: string } }) => [m.role, m.source.kind, m.text]),
    [
      ['user', 'voice', '你好'],
      ['user', 'typed', '打字进来'],
      ['assistant', 'voice', '我在这里'],
    ],
  );
  assert.equal(body.messages[1].source.clientMessageId, clientMessageId);
  assert.equal(body.messages[0].source.nativeItemId, 'u1');
  await call.stop();
});

test('after the call is stopped the same route still returns its captions from the durable rows', async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  const callId = randomUUID();
  const call = await talkingCall(f, callId);
  await call.observe(speech('user', 'u1', '挂断前说的话'));
  await call.sendText('挂断前打的字', randomUUID());
  await call.stop();
  assert.equal(call.status().state, 'closed');
  const reply = await f.get(callId);
  assert.equal(reply.statusCode, 200);
  assert.deepEqual(
    reply.json().messages.map((m: { text: string }) => m.text),
    ['挂断前说的话', '挂断前打的字'],
  );
});

test('the route sits beside the call status route without shadowing it, and the plugin still guards it', async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  const callId = randomUUID();
  const call = await talkingCall(f, callId);
  const status = await f.app.inject({ method: 'GET', url: `/api/concierge/live/${callId}`, headers: f.headers });
  assert.equal(status.statusCode, 200);
  assert.equal(status.json().callId, callId, 'the status route is unchanged');
  assert.notEqual(status.json().kind, 'transcript');
  assert.equal(
    (await f.app.inject({ method: 'GET', url: `/api/concierge/live/${callId}/transcript` })).statusCode,
    401,
  );
  assert.equal((await f.get(callId, { remoteAddress: '192.0.2.10' })).statusCode, 403);
  await call.stop();
});

test('a call id the owner never had is an empty transcript, not an error and not someone else’s rows', async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  const mine = randomUUID();
  const call = await talkingCall(f, mine);
  await call.observe(speech('user', 'u1', '我的话'));
  const stranger = await f.get(randomUUID());
  assert.equal(stranger.statusCode, 200);
  assert.deepEqual(stranger.json().messages, []);
  assert.equal(stranger.json().hasMore, false);
  await call.stop();
});
