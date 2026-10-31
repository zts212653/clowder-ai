import assert from 'node:assert/strict';
import { test } from 'node:test';
import Fastify from 'fastify';
import { MessageStore } from '../../src/domains/cats/services/stores/ports/MessageStore.js';
import { companionDecisionRoutes } from '../../src/routes/companion-decision-routes.js';
import { adaptMessageStore, canonicalTestMessageInput } from '../helpers/message-from-fixtures.js';

const source = {
  userId: 'owner',
  catId: 'codex61-sol',
  threadId: 'thread_muwb72liovvdkrhr',
  content:
    '修复已合入 #5311。正式 runtime 尚未加载。\n\n@co-creator\n现在可以更新并重启正式猫咖，加载这版让你继续测吗？',
  mentions: [],
  mentionsUser: true,
  timestamp: 100,
};

async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const previous = process.env.DEFAULT_OWNER_USER_ID;
  process.env.DEFAULT_OWNER_USER_ID = 'owner';
  t.after(async () => {
    if (previous === undefined) delete process.env.DEFAULT_OWNER_USER_ID;
    else process.env.DEFAULT_OWNER_USER_ID = previous;
  });
  const app = Fastify();
  const messages = adaptMessageStore(new MessageStore());
  t.after(() => app.close());
  app.addHook('preHandler', async (request) => {
    request.sessionUserId = String(request.headers['x-test-session'] ?? '');
  });
  app.get('/api/approval-hub/pending', async () => ({ items: [], coverage: { state: 'complete' } }));
  app.get('/api/entrusted-work/needs-me', async () => ({ ownerReads: [], coverage: { state: 'complete' } }));
  await app.register(companionDecisionRoutes, { ownerUserId: 'owner', messageStore: messages, now: () => 0 });
  const read = async () =>
    (
      await app.inject({
        url: '/api/concierge/work/decisions?view=unified&includeUserMentions=true',
        headers: { 'x-test-session': 'owner' },
      })
    ).json();
  return { app, messages, read };
}

test('26 outstanding requests show the newest on page one and keep the older valid requests reachable', async (t) => {
  const { app, messages, read } = await fixture(t);
  const oldest = messages.append({ ...source, threadId: 'oldest', timestamp: 1 });
  for (let index = 1; index < 25; index++)
    messages.append({ ...source, threadId: `old-${index}`, timestamp: index + 1 });
  const newest = messages.append({ ...source, threadId: 'newest', timestamp: 1_000 });
  const firstPage = await read();
  assert.equal(firstPage.totalCount, 26);
  assert.equal(firstPage.items[0].userMention.messageId, newest.id);
  assert.equal(firstPage.items.length, 20);
  const secondPage = (
    await app.inject({
      url: '/api/concierge/work/decisions?view=unified&includeUserMentions=true&offset=20',
      headers: { 'x-test-session': 'owner' },
    })
  ).json();
  assert.equal(secondPage.items.length, 6);
  assert.equal(secondPage.items[5].userMention.messageId, oldest.id);
});

test('canceling the newest queued request restores the preceding unanswered request and preserves acknowledgement', async (t) => {
  const { messages, read } = await fixture(t);
  const first = messages.append(source);
  const queued = messages.append({ ...source, timestamp: 101, deliveryStatus: 'queued' });
  messages.markCanceled(queued.id);
  assert.equal((await read()).items[0]?.userMention.messageId, first.id);
  assert.equal(messages.resolveUserMentionRequest('owner', source.threadId, first.id), true);
  const second = messages.append({ ...source, timestamp: 102, deliveryStatus: 'queued' });
  messages.markCanceled(second.id);
  assert.equal((await read()).totalCount, 0);
});

test('deleting and restoring a request reindexes its source, but restoring cannot undo a handled request', async (t) => {
  const { messages, read } = await fixture(t);
  const msg = messages.append(source);
  messages.softDelete(msg.id, 'owner');
  assert.equal((await read()).totalCount, 0);
  messages.restore(msg.id);
  assert.equal((await read()).items[0]?.userMention.messageId, msg.id);
  messages.resolveUserMentionRequest('owner', source.threadId, msg.id);
  messages.softDelete(msg.id, 'owner');
  messages.restore(msg.id);
  assert.equal((await read()).totalCount, 0);
});

test('a late-delivered human reply fences older requests when the newer queued mention is canceled', async (t) => {
  const { messages, read } = await fixture(t);
  messages.append(source);
  const reply = messages.append({
    ...source,
    catId: null,
    mentionsUser: false,
    timestamp: 101,
    deliveryStatus: 'queued',
  });
  const newer = messages.append({ ...source, timestamp: 102, deliveryStatus: 'queued' });
  messages.markDelivered(reply.id, 103);
  assert.equal((await read()).items[0]?.userMention.messageId, newer.id);
  messages.markCanceled(newer.id);
  assert.equal((await read()).totalCount, 0);
});

for (const [scenario, readBeforeLaterCommit] of [
  ['read before later commit', true],
  ['older boundary after both commits', false],
] as const) {
  test(`durable reads preserve later-visible lower-id @you requests — ${scenario}`, () => {
    const messages = new MessageStore();
    const firstCommitted = messages.append(
      canonicalTestMessageInput({
        ...source,
        catId: 'codex61-sol',
        content: '@co-creator first committed',
        timestamp: 200,
      }),
    );
    let laterVisible: ReturnType<MessageStore['append']>;
    let handled: boolean;
    if (readBeforeLaterCommit) {
      handled = messages.resolveUserMentionRequestFromRead('owner', source.threadId, firstCommitted.id, 1_000);
      laterVisible = messages.append(
        canonicalTestMessageInput({
          ...source,
          catId: 'codex61-sol',
          content: '@co-creator later visible',
          timestamp: 100,
        }),
      );
      assert.equal(handled, true);
      assert.deepEqual(
        messages.listHandledUserMentions('owner').map((message) => message.id),
        [firstCommitted.id],
      );
    } else {
      laterVisible = messages.append(
        canonicalTestMessageInput({
          ...source,
          catId: 'codex61-sol',
          content: '@co-creator later visible',
          timestamp: 100,
        }),
      );
      handled = messages.resolveUserMentionRequestFromRead('owner', source.threadId, firstCommitted.id, 1_000);
      assert.equal(handled, false);
      assert.deepEqual(messages.listHandledUserMentions('owner'), []);
    }

    assert.ok(laterVisible.id < firstCommitted.id, 'fixture requires message-id order to oppose commit order');
    assert.ok(
      (messages.getVisibilitySeq(laterVisible.id) ?? 0) > (messages.getVisibilitySeq(firstCommitted.id) ?? 0),
      'fixture requires the later commit to have the later visibility position',
    );
    assert.deepEqual(
      messages.listUserMentionRequests('owner').map((message) => message.id),
      [laterVisible.id],
    );
  });
}

test('F320 explicit mention enters the existing mailbox once, updates, and closes on human reply', async (t) => {
  const { app, messages, read } = await fixture(t);
  messages.append({ ...source, mentionsUser: false });
  assert.equal((await read()).totalCount, 0);
  const first = messages.append(source);
  const initial = await read();
  assert.equal(initial.totalCount, 1);
  assert.equal(initial.items[0].userMention.messageId, first.id);
  assert.equal(initial.items[0].userMention.content, source.content);
  assert.equal(initial.items[0].kind, 'user_mention');
  const next = messages.append({ ...source, timestamp: 101, content: '@co-creator\n请在今天有空时重启。' });
  const updated = await read();
  assert.equal(updated.totalCount, 1);
  assert.equal(updated.items[0].decisionRef, initial.items[0].decisionRef);
  assert.equal(updated.items[0].userMention.messageId, next.id);
  messages.append({
    ...source,
    catId: null,
    mentionsUser: false,
    content: '可以，稍后重启',
    timestamp: 102,
  });
  assert.equal((await read()).totalCount, 0);
  const history = (
    await app.inject({
      url: '/api/concierge/work/decisions?view=unified&includeUserMentions=true&mentionPeriod=handled',
      headers: { 'x-test-session': 'owner' },
    })
  ).json();
  assert.equal(history.items[0]?.userMention.messageId, next.id);
  assert.equal(history.items[0]?.userMention.handledReason, 'replied');
  assert.equal(history.items[0]?.userMention.handledAt, 102);
});

test('handled action is owner fenced and cannot close a newer request; a new mention reopens it', async (t) => {
  const { app, messages, read } = await fixture(t);
  const first = messages.append(source);
  const resolve = (messageId: string, user = 'owner') =>
    app.inject({
      method: 'POST',
      url: `/api/concierge/work/mentions/${source.threadId}/resolve`,
      headers: { 'x-test-session': user, origin: 'http://localhost' },
      payload: { expectedMessageId: messageId },
    });
  assert.equal((await resolve(first.id, 'other')).statusCode, 403);
  const next = messages.append({ ...source, timestamp: 101 });
  assert.equal((await resolve(first.id)).statusCode, 409);
  assert.equal((await read()).totalCount, 1);
  assert.equal((await resolve(next.id)).statusCode, 200);
  assert.equal((await read()).totalCount, 0);
  const history = (
    await app.inject({
      url: '/api/concierge/work/decisions?view=unified&includeUserMentions=true&mentionPeriod=handled',
      headers: { 'x-test-session': 'owner' },
    })
  ).json();
  assert.equal(history.items[0]?.userMention.handledReason, 'ignored');
  messages.append({ ...source, timestamp: 103 });
  assert.equal((await read()).totalCount, 1);
});

test('no mention, private speech, system messages, and other owners never become a request or human closure', async (t) => {
  const { messages, read } = await fixture(t);
  messages.append({ ...source, visibility: 'whisper', timestamp: 90 });
  messages.append({ ...source, userId: 'other', timestamp: 91 });
  messages.append({ ...source, mentionsUser: false, timestamp: 92 });
  assert.equal((await read()).totalCount, 0);
  messages.append(source);
  messages.append({
    ...source,
    catId: null,
    mentionsUser: false,
    extra: { systemKind: 'a2a_routing' },
    timestamp: 101,
  });
  messages.append({ ...source, mentionsUser: false, timestamp: 102 });
  assert.equal((await read()).totalCount, 1);
});

test('replacement flag added at persistence creates a request, but older flags cannot reopen after human reply', async (t) => {
  const { messages, read } = await fixture(t);
  const msg = messages.append({ ...source, mentionsUser: false });
  messages.augmentStreamMetadata(msg.id, { mentionsUser: true });
  assert.equal((await read()).totalCount, 1);
  messages.append({ ...source, catId: null, mentionsUser: false, timestamp: 102 });
  messages.augmentStreamMetadata(msg.id, { mentionsUser: true });
  assert.equal((await read()).totalCount, 0);
});

test('mailbox adopts mentions explicitly; existing Live and other decision consumers keep their contract', async (t) => {
  const { app, messages } = await fixture(t);
  messages.append(source);
  const prior = await app.inject({
    url: '/api/concierge/work/decisions?view=unified',
    headers: { 'x-test-session': 'owner' },
  });
  assert.equal(prior.json().totalCount, 0);
  assert.equal(prior.json().sources.userMentions, undefined);
});

test('a failed mention source remains partial and cannot claim an exact zero', async (t) => {
  const { messages, read } = await fixture(t);
  messages.listUserMentionRequests = () => {
    throw new Error('source unavailable');
  };
  const body = await read();
  assert.equal(body.status, 'partial');
  assert.equal(body.sources.userMentions.status, 'unavailable');
  assert.equal(body.totalCount, undefined);
});

test('handled action rejects anonymous, nonlocal, forged, and malformed requests before mutation', async (t) => {
  const { app, messages, read } = await fixture(t);
  const msg = messages.append(source);
  const input = {
    method: 'POST' as const,
    url: `/api/concierge/work/mentions/${source.threadId}/resolve`,
    payload: { expectedMessageId: msg.id },
  };
  assert.equal(
    (await app.inject({ ...input, headers: { origin: 'http://localhost', 'x-cat-cafe-user': 'owner' } })).statusCode,
    401,
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
    (await app.inject({ ...input, headers: { origin: 'https://untrusted.example', 'x-test-session': 'owner' } }))
      .statusCode,
    403,
  );
  assert.equal(
    (
      await app.inject({
        ...input,
        headers: { origin: 'http://localhost', 'x-test-session': 'owner' },
        payload: { expectedMessageId: '', userId: 'other' },
      })
    ).statusCode,
    400,
  );
  assert.equal((await read()).totalCount, 1);
});
