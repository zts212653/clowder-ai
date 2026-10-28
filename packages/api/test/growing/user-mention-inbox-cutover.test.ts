import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MessageStore } from '../../src/domains/cats/services/stores/ports/MessageStore.js';
import { canonicalTestMessageInput } from '../helpers/message-from-fixtures.js';
import { registerMentionRestorationTests } from '../helpers/user-mention-restoration-contract.js';

const request = {
  userId: 'owner',
  catId: 'codex61-sol',
  threadId: 'thread',
  content: '@co-creator\n请重启',
  mentions: [],
  mentionsUser: true,
  timestamp: 100,
};

test('activation is fixed once; 558 legacy requests do not become current attention and handled state survives', async () => {
  const store = new MessageStore();
  for (let n = 0; n < 558; n++) store.append(canonicalTestMessageInput({ ...request, threadId: `legacy-${n}` }));
  const handled = store.append(canonicalTestMessageInput({ ...request, threadId: 'handled' }));
  store.resolveUserMentionRequest('owner', 'handled', handled.id);
  assert.equal(await store.initializeUserMentionInbox(200), 200);
  assert.equal(await store.initializeUserMentionInbox(300), 200);
  assert.equal(store.listUserMentionRequests('owner').filter((m) => m.timestamp >= 200).length, 0);
  assert.deepEqual(
    (await store.listHandledUserMentions('owner')).map((m) => m.id),
    [handled.id],
  );
  const fresh = store.append(canonicalTestMessageInput({ ...request, timestamp: 201 }));
  assert.deepEqual(
    store
      .listUserMentionRequests('owner')
      .filter((m) => m.timestamp >= 200)
      .map((m) => m.id),
    [fresh.id],
  );
});

test('bulk exact snapshots preserve human replies/new requests and undo only once without resurrecting replies', async () => {
  const store = new MessageStore();
  const a = store.append(canonicalTestMessageInput({ ...request, threadId: 'a' }));
  const b = store.append(canonicalTestMessageInput({ ...request, threadId: 'b' }));
  const refs = [a, b].map((m) => ({ threadId: m.threadId, messageId: m.id }));
  const result = await store.handleUserMentionRequests('owner', refs);
  assert.ok(result);
  assert.equal(result.handled, 2);
  assert.equal(store.listUserMentionRequests('owner').length, 0);
  assert.equal((await store.listHandledUserMentions('owner')).length, 2);
  store.append(
    canonicalTestMessageInput({ ...request, threadId: 'a', catId: null, mentionsUser: false, timestamp: 101 }),
  );
  const newer = store.append(canonicalTestMessageInput({ ...request, threadId: 'b', timestamp: 102 }));
  assert.equal(await store.undoUserMentionHandling('other', result.undoId), null);
  assert.deepEqual(await store.undoUserMentionHandling('owner', result.undoId), { restored: 0 });
  assert.deepEqual(
    store.listUserMentionRequests('owner').map((m) => m.id),
    [newer.id],
  );
  assert.equal(await store.undoUserMentionHandling('owner', result.undoId), null);
});

test('bulk undo restores exact requests but not pre-existing handled rows; a stale snapshot closes nothing', async () => {
  const store = new MessageStore();
  const closed = store.append(canonicalTestMessageInput({ ...request, threadId: 'already' }));
  store.resolveUserMentionRequest('owner', 'already', closed.id);
  const first = store.append(canonicalTestMessageInput(request));
  const replacement = store.append(canonicalTestMessageInput({ ...request, timestamp: 101 }));
  assert.equal(await store.handleUserMentionRequests('owner', [{ threadId: 'thread', messageId: first.id }]), null);
  const result = await store.handleUserMentionRequests('owner', [{ threadId: 'thread', messageId: replacement.id }]);
  assert.ok(result);
  assert.deepEqual(await store.undoUserMentionHandling('owner', result.undoId), { restored: 1 });
  assert.deepEqual(
    store.listUserMentionRequests('owner').map((m) => m.id),
    [replacement.id],
  );
  assert.deepEqual(
    (await store.listHandledUserMentions('owner')).map((m) => m.id),
    [closed.id],
  );
});

test('mailbox defaults to only post-load recent requests, exposes earlier separately, and bulk history never affects its badge', async (t) => {
  const { default: Fastify } = await import('fastify');
  const { companionDecisionRoutes } = await import('../../src/routes/companion-decision-routes.js');
  const app = Fastify();
  t.after(() => app.close());
  const store = new MessageStore();
  const now = Date.now();
  const legacy = store.append(
    canonicalTestMessageInput({ ...request, threadId: 'legacy', timestamp: now - 25 * 86400000 }),
  );
  const oldHandled = store.append(
    canonicalTestMessageInput({ ...request, threadId: 'handled', timestamp: now - 24 * 86400000 }),
  );
  store.resolveUserMentionRequest('owner', 'handled', oldHandled.id);
  const previous = process.env.DEFAULT_OWNER_USER_ID;
  process.env.DEFAULT_OWNER_USER_ID = 'owner';
  t.after(() => {
    if (previous === undefined) delete process.env.DEFAULT_OWNER_USER_ID;
    else process.env.DEFAULT_OWNER_USER_ID = previous;
  });
  app.addHook('preHandler', async (r) => {
    r.sessionUserId = String(r.headers['x-test-session'] ?? '');
  });
  app.get('/api/approval-hub/pending', async () => ({ items: [], coverage: { state: 'complete' } }));
  app.get('/api/entrusted-work/needs-me', async () => ({ ownerReads: [], coverage: { state: 'complete' } }));
  await app.register(companionDecisionRoutes, {
    ownerUserId: 'owner',
    collectiveAccountability: async () => ({
      status: 200,
      body: {
        data: {
          items: [],
          reasons: [],
          state: {
            coverage: 'pending_f290_collective_accountability_requests',
            status: 'available',
            exhaustiveness: 'complete',
            startedAt: 1,
            observedAt: 2,
          },
        },
      },
    }),
    messageStore: store,
    runtimeInteractionStore: {
      listPendingByUser: async () => [],
      readPendingIndexByUser: async () => ({ records: [], exhaustiveness: 'complete' }),
    },
    now: () => now,
    threadStore: { get: () => ({ id: 'thread', createdBy: 'owner', title: 'F320 登录修复' }) },
  });
  const get = (period = 'recent') =>
    app.inject({
      url: `/api/concierge/work/decisions?view=unified&includeUserMentions=true&mentionPeriod=${period}`,
      headers: { 'x-test-session': 'owner' },
    });
  assert.equal((await get()).json().totalCount, 0);
  assert.equal((await get('earlier')).json().items[0].userMention.messageId, legacy.id);
  assert.equal((await get('earlier')).json().attentionCount, 0);
  const fresh = store.append(
    canonicalTestMessageInput({ ...request, timestamp: now + 1, content: '@co-creator\n需要你重启，建议空闲时操作' }),
  );
  const read = (await get()).json();
  assert.equal(read.totalCount, 1);
  assert.equal(read.attentionCount, 0, 'explicit @you rows stay visible without increasing the decision badge');
  assert.equal(read.items[0].userMention.threadTitle, 'F320 登录修复');
  const preview = await app.inject({
    url: '/api/concierge/work/mentions/handling-preview?period=all',
    headers: { 'x-test-session': 'owner' },
  });
  assert.equal(preview.json().requests.length, 2);
  const previewPeriod = async (period: string) =>
    (
      await app.inject({
        url: `/api/concierge/work/mentions/handling-preview?period=${period}`,
        headers: { 'x-test-session': 'owner' },
      })
    ).json();
  assert.equal((await previewPeriod('week')).requests.length, 1);
  assert.equal((await previewPeriod('earlier')).requests.length, 1);
  assert.deepEqual((await previewPeriod('all')).counts, { week: 1, earlier: 1 });

  const action = await app.inject({
    method: 'POST',
    url: '/api/concierge/work/mentions/handle',
    headers: { 'x-test-session': 'owner', origin: 'http://localhost' },
    payload: { requests: preview.json().requests },
  });
  assert.equal(action.statusCode, 200);
  assert.equal(action.json().handled, 2);
  const saved = await app.inject({
    url: '/api/concierge/work/mentions/last-handling',
    headers: { 'x-test-session': 'owner' },
  });
  assert.deepEqual(saved.json().receipt, { ...action.json(), remaining: 2 });
  assert.equal((await app.inject({ url: '/api/concierge/work/mentions/last-handling' })).statusCode, 401);
  assert.equal(
    (await app.inject({ url: '/api/concierge/work/mentions/last-handling', headers: { 'x-test-session': 'other' } }))
      .statusCode,
    403,
  );
  const restoreInput = {
    method: 'POST' as const,
    url: '/api/concierge/work/mentions/restore',
    payload: {
      threadId: fresh.threadId,
      messageId: fresh.id,
      expectedRevision: (await store.getUserMentionStateRevisions('owner'))[fresh.threadId],
    },
  };
  assert.equal((await app.inject({ ...restoreInput, headers: { origin: 'http://localhost' } })).statusCode, 401);
  assert.equal(
    (await app.inject({ ...restoreInput, headers: { 'x-test-session': 'other', origin: 'http://localhost' } }))
      .statusCode,
    403,
  );
  assert.equal(
    (
      await app.inject({
        ...restoreInput,
        remoteAddress: '192.0.2.1',
        headers: { 'x-test-session': 'owner', origin: 'http://localhost' },
      })
    ).statusCode,
    403,
  );
  assert.equal(
    (await app.inject({ ...restoreInput, headers: { 'x-test-session': 'owner', origin: 'https://bad.example' } }))
      .statusCode,
    403,
  );

  assert.equal((await get('handled')).json().items.length, 3);
  const undone = await app.inject({
    method: 'POST',
    url: '/api/concierge/work/mentions/undo',
    headers: { 'x-test-session': 'owner', origin: 'http://localhost' },
    payload: { undoId: action.json().undoId },
  });
  assert.equal(undone.statusCode, 200);
  assert.equal(undone.json().restored, 2);
  assert.deepEqual(
    (await get()).json().items.map((i) => i.userMention.messageId),
    [fresh.id],
  );
});

test('bulk and undo refuse missing sessions, foreign owners, malformed and nonlocal writes before changing requests', async (t) => {
  const { default: Fastify } = await import('fastify');
  const { companionDecisionRoutes } = await import('../../src/routes/companion-decision-routes.js');
  const previous = process.env.DEFAULT_OWNER_USER_ID;
  process.env.DEFAULT_OWNER_USER_ID = 'owner';
  t.after(() => {
    if (previous === undefined) delete process.env.DEFAULT_OWNER_USER_ID;
    else process.env.DEFAULT_OWNER_USER_ID = previous;
  });
  const app = Fastify();
  t.after(() => app.close());
  const store = new MessageStore();
  const msg = store.append(canonicalTestMessageInput(request));
  app.addHook('preHandler', async (r) => {
    r.sessionUserId = String(r.headers['x-test-session'] ?? '');
  });
  await app.register(companionDecisionRoutes, { ownerUserId: 'owner', messageStore: store, now: () => 0 });
  const input = {
    method: 'POST' as const,
    url: '/api/concierge/work/mentions/handle',
    payload: { requests: [{ threadId: msg.threadId, messageId: msg.id }] },
  };
  assert.equal(
    (await app.inject({ ...input, headers: { origin: 'http://localhost', 'x-cat-cafe-user': 'owner' } })).statusCode,
    401,
  );
  assert.equal(
    (await app.inject({ ...input, headers: { origin: 'http://localhost', 'x-test-session': 'other' } })).statusCode,
    403,
  );
  assert.equal(
    (
      await app.inject({
        ...input,
        remoteAddress: '192.0.2.1',
        headers: { origin: 'http://localhost', 'x-test-session': 'owner' },
      })
    ).statusCode,
    403,
  );
  assert.equal(
    (await app.inject({ ...input, headers: { origin: 'https://bad.example', 'x-test-session': 'owner' } })).statusCode,
    403,
  );
  assert.equal(
    (
      await app.inject({
        ...input,
        payload: { requests: [], other: 'bad' },
        headers: { origin: 'http://localhost', 'x-test-session': 'owner' },
      })
    ).statusCode,
    400,
  );
  assert.equal(store.listUserMentionRequests('owner').length, 1);
  const action = await app.inject({ ...input, headers: { origin: 'http://localhost', 'x-test-session': 'owner' } });
  assert.equal(action.statusCode, 200);
  assert.equal(
    (
      await app.inject({
        method: 'POST',
        url: '/api/concierge/work/mentions/undo',
        payload: { undoId: action.json().undoId },
        headers: { origin: 'http://localhost', 'x-test-session': 'other' },
      })
    ).statusCode,
    403,
  );
  assert.equal(store.listUserMentionRequests('owner').length, 0);
});

registerMentionRestorationTests(() => new MessageStore());

for (const [day, hours] of [
  [12, 16],
  [13, 40],
]) {
  test(`rolling week retains unanswered weekend requests on October ${day}`, async () => {
    const { readUserMentionTodos } = await import('../../src/routes/user-mention-todo-projection.js');
    const now = new Date(2026, 9, day, 10).getTime();
    const store = new MessageStore();
    store.append(canonicalTestMessageInput({ ...request, timestamp: now - hours * 3600000 }));
    const result = await readUserMentionTodos(store, 'owner', { cutover: now - 7 * 86400000, now, period: 'week' });
    assert.equal(result.items.length, 1);
    assert.equal(result.recentCount, 1);
  });
}

test('thread title lookup fails per row without failing approvals or disclosing another owner title', async (t) => {
  const { default: Fastify } = await import('fastify');
  const { companionDecisionRoutes } = await import('../../src/routes/companion-decision-routes.js');
  const app = Fastify();
  t.after(() => app.close());
  const store = new MessageStore();
  store.append(canonicalTestMessageInput(request));
  const previous = process.env.DEFAULT_OWNER_USER_ID;
  process.env.DEFAULT_OWNER_USER_ID = 'owner';
  t.after(() => {
    if (previous === undefined) delete process.env.DEFAULT_OWNER_USER_ID;
    else process.env.DEFAULT_OWNER_USER_ID = previous;
  });
  app.addHook('preHandler', async (r) => {
    r.sessionUserId = 'owner';
  });
  app.get('/api/approval-hub/pending', async () => ({ items: [], coverage: { state: 'complete' } }));
  app.get('/api/entrusted-work/needs-me', async () => ({ ownerReads: [], coverage: { state: 'complete' } }));
  let broken = false;
  await app.register(companionDecisionRoutes, {
    ownerUserId: 'owner',
    messageStore: store,
    now: () => 0,
    threadStore: {
      get: async () => {
        if (broken) throw new Error('title unavailable');
        return { createdBy: 'other', title: 'private title' };
      },
    },
  });
  const read = () => app.inject('/api/concierge/work/decisions?view=unified&includeUserMentions=true');
  const first = await read();
  assert.equal(first.statusCode, 200);
  assert.equal(first.json().items[0].userMention.threadTitle, 'thread');
  broken = true;
  const second = await read();
  assert.equal(second.statusCode, 200);
  assert.equal(second.json().items[0].userMention.threadTitle, 'thread');
});
