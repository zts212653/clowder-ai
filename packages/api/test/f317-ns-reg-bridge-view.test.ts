// F317 north-star regression harness, Tier A (Host bridge): reading history, opening the chat and
// asking for state are views. They must never end, restart or re-route a prepared call, nor touch
// screen sharing. Typed text goes to exactly one path (no call: ordinary conversation; call: the call).
// Self-contained fixture derived from f317-companion-bridge.test.ts; that file is not edited.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
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
import { sessionAuthPlugin, sessionRoute } from '../src/infrastructure/session-auth.js';
import { conciergeRoutes } from '../src/routes/concierge.js';
import { requirePluginOwnerLocalAccess } from '../src/routes/plugin-access-guards.js';

const OWNER = 'ns-reg-owner';
const SDP = 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n';

interface Recorded {
  readonly method: string;
  readonly path: string;
  readonly body: unknown;
}

async function fixture(history: unknown[] = [], hasMore = false, open: 'ok' | 'refused' | 'throws' = 'ok') {
  const previousOwner = process.env.DEFAULT_OWNER_USER_ID;
  process.env.DEFAULT_OWNER_USER_ID = OWNER;
  const app = Fastify();
  await app.register(cookie);
  await app.register(sessionAuthPlugin);
  await app.register(sessionRoute, { ownerUserId: OWNER });
  const config = new MemoryConciergeConfigStore();
  await config.put(OWNER, { ...CONCIERGE_CONFIG_DEFAULTS, dutyCatProfileId: 'opus', displayName: 'ns-reg companion' });
  const threads = new ConciergeThreadService({ threadStore: new ThreadStore(), conciergeConfigStore: config });
  await app.register(conciergeRoutes, {
    conciergeConfigStore: config,
    conciergeThreadService: threads,
    conciergeRelayStore: new MemoryConciergeRelayStore(),
    conciergeConfirmationStore: new MemoryConciergeConfirmationStore(),
    messageStore: new MessageStore(),
  });
  const calls: Recorded[] = [];
  const callId = randomUUID();
  const textIds = new Set<string>();
  await app.register(async (routes) => {
    routes.addHook('preHandler', async (request, reply) => {
      const access = requirePluginOwnerLocalAccess(request, request.method === 'GET' ? 'read' : 'write');
      if ('error' in access) return reply.code(access.status).send({ error: access.error });
      calls.push({ method: request.method, path: request.url, body: request.body });
    });
    routes.post('/api/concierge/live', async (_request, reply) => reply.code(202).send({ callId, state: 'ready' }));
    routes.get('/api/concierge/live/:id', async () => ({
      callId,
      catId: 'codex',
      state: 'ready',
      toolsReady: true,
      nativeActivity: 'none',
      nativeWork: { scopeId: null, revision: 0, active: [], recent: [] },
    }));
    routes.post('/api/concierge/live/:id/start', async () => ({
      answer: 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n',
    }));
    routes.post('/api/concierge/live/:id/text', async () => ({ delivery: 'accepted' }));
    routes.post('/api/concierge/live/:id/screen', async () => ({ ok: true }));
    routes.delete('/api/concierge/live/:id', async () => ({ stopped: true }));
    routes.post('/api/messages', async (request) => {
      const id = (request.body as { idempotencyKey: string }).idempotencyKey;
      if (textIds.has(id)) return { status: 'duplicate', userMessageId: id };
      textIds.add(id);
      return { status: 'processing' };
    });
    routes.get('/api/messages', async () => ({ messages: history, hasMore }));
    routes.get('/api/threads/:id', async () => ({ title: '同一段聊天' }));
    routes.get('/api/concierge/work/decisions', async () => ({
      status: 'available',
      approvalCount: 0,
      needsMeCount: 0,
      otherNeedsMeCount: 0,
      approvals: [],
      otherNeedsMe: [],
      page: { offset: 0, limit: 5, hasMoreApprovals: false, hasMoreNeedsMe: false },
    }));
  });
  const opened: string[] = [];
  const bridge = new CompanionHostBridge({
    app,
    ownerUserId: OWNER,
    origin: 'http://localhost:3011',
    assertCurrent: async () => {},
    publicCompanionV2: true,
    openConversation: async (threadId: string) => {
      opened.push(threadId);
      if (open === 'throws') throw new Error('workspace unavailable');
      return open === 'ok';
    },
  });
  return {
    bridge,
    calls,
    callId,
    opened,
    threads,
    since: (mark: number) => calls.slice(mark),
    cleanup: async () => {
      await bridge.close();
      await app.close();
      if (previousOwner === undefined) delete process.env.DEFAULT_OWNER_USER_ID;
      else process.env.DEFAULT_OWNER_USER_ID = previousOwner;
    },
  };
}

test('reading history, opening the chat and asking for state leave a prepared, connected, sharing call untouched', async (t) => {
  const f = await fixture([{ id: 'm1', type: 'user', content: '你好', catId: null }]);
  t.after(f.cleanup);
  const prepared = await f.bridge.request({ kind: 'prepare' });
  assert.equal(prepared.kind, 'state');
  assert.equal(prepared.kind === 'state' && prepared.phase, 'ready');
  assert.equal((await f.bridge.request({ kind: 'offer', sdp: SDP })).kind, 'answer');
  assert.equal(
    (await f.bridge.request({ kind: 'screen.open', selectionId: randomUUID(), label: '测试窗口' })).kind,
    'ok',
  );
  const before = await f.bridge.request({ kind: 'state' });
  const mark = f.calls.length;

  for (let i = 0; i < 3; i++) {
    assert.equal((await f.bridge.request({ kind: 'conversation.read' })).kind, 'conversation');
    assert.deepEqual(await f.bridge.request({ kind: 'conversation.open' }), {
      kind: 'navigation',
      delivery: 'requested',
    });
    assert.equal((await f.bridge.request({ kind: 'decisions.read', offset: 0, limit: 5 })).kind, 'decisions');
  }
  const after = await f.bridge.request({ kind: 'state' });

  assert.deepEqual(after, before, 'the observable call state is identical after any number of view operations');
  const mutating = f
    .since(mark)
    .filter((call) => call.method !== 'GET' && !call.path.startsWith('/api/concierge/thread'));
  assert.deepEqual(mutating, [], 'no DELETE, no /start, no /screen, no /text and no second /live was issued by a view');
  assert.equal(f.opened.length, 3);
});

test('navigation never claims more than the Host confirmed: refused is unconfirmed, a failure is an error', async (t) => {
  const refused = await fixture([], false, 'refused');
  t.after(refused.cleanup);
  assert.deepEqual(await refused.bridge.request({ kind: 'conversation.open' }), {
    kind: 'navigation',
    delivery: 'unconfirmed',
  });
  const broken = await fixture([], false, 'throws');
  t.after(broken.cleanup);
  const reply = await broken.bridge.request({ kind: 'conversation.open' });
  assert.equal(reply.kind, 'error');
  assert.equal(JSON.stringify(reply).includes('workspace unavailable'), false, 'the raw cause stays private');
});

test('a view never starts a call by itself', async (t) => {
  const f = await fixture([{ id: 'm1', type: 'user', content: '你好', catId: null }]);
  t.after(f.cleanup);
  await f.bridge.request({ kind: 'conversation.read' });
  await f.bridge.request({ kind: 'conversation.open' });
  const state = await f.bridge.request({ kind: 'state' });
  assert.equal(state.kind === 'state' && state.phase, 'idle');
  assert.equal(
    f.calls.some((call) => call.method === 'POST' && call.path === '/api/concierge/live'),
    false,
  );
});

test('typed text goes down exactly one path: the ordinary conversation without a call, the call with one', async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  const idle = randomUUID();
  assert.deepEqual(await f.bridge.request({ kind: 'text', text: '没有通话', clientMessageId: idle }), {
    kind: 'delivery',
    delivery: 'accepted',
  });
  assert.equal(f.calls.filter((call) => call.path === '/api/messages' && call.method === 'POST').length, 1);
  assert.equal(
    f.calls.some((call) => call.path.endsWith('/text')),
    false,
    'no call, so nothing is sent to a call',
  );

  await f.bridge.request({ kind: 'prepare' });
  assert.equal((await f.bridge.request({ kind: 'offer', sdp: SDP })).kind, 'answer');
  const messagesBefore = f.calls.filter((call) => call.path === '/api/messages' && call.method === 'POST').length;
  const inCall = randomUUID();
  for (let i = 0; i < 2; i++)
    assert.deepEqual(await f.bridge.request({ kind: 'text', text: '通话里', clientMessageId: inCall }), {
      kind: 'delivery',
      delivery: 'accepted',
    });
  assert.equal(
    f.calls.filter((call) => call.path === '/api/messages' && call.method === 'POST').length,
    messagesBefore,
    'with a call, typed text never also goes to the ordinary conversation',
  );
  const sent = f.calls.filter((call) => call.method === 'POST' && call.path.endsWith('/text'));
  assert.equal(sent.length, 2);
  assert.ok(sent.every((call) => (call.body as { clientMessageId: string }).clientMessageId === inCall));
});

test('history keeps identical texts as separate rows in source order, and stays honest about what it cut', async (t) => {
  const rows = [
    { id: 'a', type: 'user', content: '好的', catId: null },
    { id: 'b', type: 'user', content: '好的', catId: null },
    { id: 'c', type: 'assistant', content: '好的', catId: 'opus' },
  ];
  const f = await fixture(rows, true);
  t.after(f.cleanup);
  const reply = await f.bridge.request({ kind: 'conversation.read' });
  assert.equal(reply.kind, 'conversation');
  if (reply.kind !== 'conversation') return;
  assert.deepEqual(
    reply.messages.map((message) => message.id),
    ['a', 'b', 'c'],
  );
  assert.equal(reply.hasMore, true, 'the source said there is more and the projection must not hide that');
});

test('history is bounded to the newest 32 rows and says so when a long text is clipped', async (t) => {
  const many = Array.from({ length: 40 }, (_, i) => ({
    id: `m${i}`,
    type: 'user',
    content: `第 ${i} 句`,
    catId: null,
  }));
  const f = await fixture(many, false);
  t.after(f.cleanup);
  const reply = await f.bridge.request({ kind: 'conversation.read' });
  assert.ok(reply.kind === 'conversation');
  if (reply.kind !== 'conversation') return;
  assert.equal(reply.messages.length, 32);
  assert.equal(reply.messages[0]?.id, 'm8');
  assert.equal(reply.messages.at(-1)?.id, 'm39');

  const long = await fixture([{ id: 'big', type: 'user', content: '长'.repeat(30_000), catId: null }], false);
  t.after(long.cleanup);
  const clipped = await long.bridge.request({ kind: 'conversation.read' });
  assert.ok(clipped.kind === 'conversation');
  if (clipped.kind !== 'conversation') return;
  assert.ok(clipped.messages[0]!.text.length < 30_000);
  assert.equal(clipped.hasMore, true, 'clipping a long message must be reported as more history');
});
