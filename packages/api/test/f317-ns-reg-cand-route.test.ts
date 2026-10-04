// F317 north-star regression harness, Tier B bound to candidate d5d293aa2e
// (GET /api/concierge/live/:id/transcript). Complements the author's single closed-call route test with the
// active-call path, owner/identity edges, malformed input, the 256-row scan window and read-only behaviour.
// No media, no visible cat; the app is in-process with an in-memory store.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import cookie from '@fastify/cookie';
import Fastify from 'fastify';
import { MessageStore } from '../src/domains/cats/services/stores/ports/MessageStore.js';
import { persistLiveUserText } from '../src/domains/concierge/live/live-transcript.js';
import { sessionAuthPlugin, sessionRoute } from '../src/infrastructure/session-auth.js';
import { registerLiveTranscriptRoutes } from '../src/routes/concierge-live-transcript.js';

const OWNER = 'ns-reg-route-owner';

async function fixture(options: { activeThread?: string; canonicalThread?: string; routeOwner?: string } = {}) {
  const previousOwner = process.env.DEFAULT_OWNER_USER_ID;
  process.env.DEFAULT_OWNER_USER_ID = OWNER;
  const app = Fastify();
  await app.register(cookie);
  await app.register(sessionAuthPlugin);
  await app.register(sessionRoute, { ownerUserId: OWNER });
  const store = new MessageStore();
  const lookups: Array<{ id: string; userId: string }> = [];
  const currentChecks: Array<{ userId: string; threadId: string }> = [];
  let current = true;
  let activeCallId: string | undefined;
  registerLiveTranscriptRoutes(app, {
    ownerUserId: options.routeOwner ?? OWNER,
    messages: store,
    sessions: {
      get: (id: string, userId: string) => {
        lookups.push({ id, userId });
        return activeCallId === id && options.activeThread
          ? ({ status: () => ({ threadId: options.activeThread }) } as never)
          : undefined;
      },
    },
    threads: {
      getOrCreate: async () => options.canonicalThread ?? 'home',
      isCurrent: async (userId: string, threadId: string) => {
        currentChecks.push({ userId, threadId });
        return current;
      },
    },
  });
  const session = await app.inject({ method: 'GET', url: '/api/session' });
  const headers = { cookie: String(session.headers['set-cookie']).split(';')[0] };
  return {
    app,
    store,
    headers,
    lookups,
    currentChecks,
    setCurrent: (value: boolean) => {
      current = value;
    },
    setActive: (id: string) => {
      activeCallId = id;
    },
    get: (callId: string, extra = '', overrides: Record<string, unknown> = {}) =>
      app.inject({ method: 'GET', url: `/api/concierge/live/${callId}/transcript${extra}`, headers, ...overrides }),
    cleanup: async () => {
      await app.close();
      if (previousOwner === undefined) delete process.env.DEFAULT_OWNER_USER_ID;
      else process.env.DEFAULT_OWNER_USER_ID = previousOwner;
    },
  };
}

const typed = (
  f: Awaited<ReturnType<typeof fixture>>,
  callId: string,
  thread: string,
  text: string,
  id = randomUUID(),
) => persistLiveUserText(f.store, { userId: OWNER, threadId: thread, callId }, text, id);

test('an ACTIVE call reads its own thread, not the canonical one; currency is checked against that thread', async (t) => {
  const f = await fixture({ activeThread: 'call-thread', canonicalThread: 'canonical-thread' });
  t.after(f.cleanup);
  const callId = randomUUID();
  f.setActive(callId);
  await typed(f, callId, 'call-thread', '在通话线程里');
  await typed(f, callId, 'canonical-thread', '在规范线程里');
  const reply = await f.get(callId);
  assert.equal(reply.statusCode, 200);
  assert.deepEqual(
    reply.json().messages.map((m: { text: string }) => m.text),
    ['在通话线程里'],
  );
  assert.deepEqual(f.currentChecks, [{ userId: OWNER, threadId: 'call-thread' }]);
  assert.deepEqual(f.lookups, [{ id: callId, userId: OWNER }]);
});

test('a RETIRED call falls back to the canonical thread and never to a thread the caller names', async (t) => {
  const f = await fixture({ canonicalThread: 'canonical-thread' });
  t.after(f.cleanup);
  const callId = randomUUID();
  await typed(f, callId, 'canonical-thread', '规范线程里的');
  await typed(f, callId, 'attacker-thread', '别的线程里的');
  const reply = await f.get(callId);
  assert.deepEqual(
    reply.json().messages.map((m: { text: string }) => m.text),
    ['规范线程里的'],
  );
  for (const selector of [
    '?threadId=attacker-thread',
    '?thread=attacker-thread',
    '?userId=other',
    '?limit=1',
    '?offset=0',
    '?callId=x',
    '?x=',
  ]) {
    assert.equal((await f.get(callId, selector)).statusCode, 400, `${selector} must be rejected, not ignored`);
  }
});

test('only the Host owner may read: another identity is refused even with a valid local session, and the body reveals nothing', async (t) => {
  const f = await fixture({ routeOwner: 'someone-else' });
  t.after(f.cleanup);
  const callId = randomUUID();
  await typed(f, callId, 'home', '私有内容');
  const reply = await f.get(callId);
  assert.equal(reply.statusCode, 403);
  assert.deepEqual(reply.json(), { error: 'Host owner required' });
  assert.equal(reply.body.includes('私有内容'), false);
  assert.equal(f.lookups.length, 0, 'a refused caller does not even probe the session registry');
  assert.equal(
    (await f.app.inject({ method: 'GET', url: `/api/concierge/live/${callId}/transcript` })).statusCode,
    401,
  );
  assert.equal((await f.get(callId, '', { remoteAddress: '192.0.2.1' })).statusCode, 403);
});

test('malformed call ids are rejected before any store or session access', async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  for (const bad of ['not-a-uuid', '123', `${randomUUID()}x`, '..%2F..%2Fetc', '%00']) {
    const reply = await f.get(bad);
    assert.ok([400, 404].includes(reply.statusCode), `${bad} -> ${reply.statusCode}`);
  }
  assert.equal(f.lookups.length, 0);
  assert.equal(f.currentChecks.length, 0);
});

test('a conversation that is no longer current answers 409 with a fixed body and no captions', async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  const callId = randomUUID();
  await typed(f, callId, 'home', '不该泄漏');
  f.setCurrent(false);
  const reply = await f.get(callId);
  assert.equal(reply.statusCode, 409);
  assert.deepEqual(reply.json(), { error: 'Companion conversation changed' });
  assert.equal(reply.body.includes('不该泄漏'), false);
});

test('the response has exactly the documented shape, and a read changes nothing', async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  const callId = randomUUID();
  await typed(f, callId, 'home', '只读');
  const before = JSON.stringify(f.store.getByThread('home', 256, OWNER));
  const first = await f.get(callId);
  const second = await f.get(callId);
  assert.deepEqual(Object.keys(first.json()).sort(), ['callId', 'hasMore', 'kind', 'messages']);
  assert.equal(first.json().kind, 'transcript');
  assert.equal(first.json().callId, callId);
  assert.equal(first.body, second.body, 'two reads are identical');
  assert.equal(JSON.stringify(f.store.getByThread('home', 256, OWNER)), before, 'a read writes nothing');
  for (const method of ['POST', 'PUT', 'DELETE', 'PATCH'] as const) {
    const reply = await f.app.inject({
      method,
      url: `/api/concierge/live/${callId}/transcript`,
      headers: f.headers,
      payload: {},
    });
    assert.ok([404, 405].includes(reply.statusCode), `${method} -> ${reply.statusCode}`);
  }
});

test('the route scans the newest 256 thread rows: many newer rows push a call out of view, and hasMore is the only sign', async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  const callId = randomUUID();
  for (let i = 0; i < 3; i++) await typed(f, callId, 'home', `通话里的第 ${i} 句`);
  for (let i = 0; i < 256; i++) {
    await f.store.appendIdempotent({
      userId: OWNER,
      threadId: 'home',
      catId: null,
      content: `后来的普通消息 ${i}`,
      mentions: [],
      timestamp: Date.now(),
      idempotencyKey: `later-${i}`,
    });
  }
  const reply = await f.get(callId);
  assert.equal(reply.statusCode, 200);
  assert.deepEqual(reply.json().messages, [], 'the call rows are outside the 256-row scan');
  assert.equal(reply.json().hasMore, true, 'honest: the scan filled up');
  // …and there is no way to ask for more: every selector is rejected (pinned above), so the rows are unreachable.
  assert.equal((await f.get(callId, '?offset=256')).statusCode, 400);
});
