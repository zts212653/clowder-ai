import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createInboxReadFixture } from './f322-inbox-read.fixture.mjs';

test('browser read preflight leaves the lifecycle untouched and permits the original owner POST', async (t) => {
  const f = await createInboxReadFixture();
  t.after(() => f.close());
  const base = `http://127.0.0.1:${f.apiPort}`;
  const origin = 'http://127.0.0.1:51117';
  const route = `/api/threads/${f.inbox.thread.id}/read/latest`;
  const preflight = await fetch(base + route, {
    method: 'OPTIONS',
    headers: {
      origin,
      'access-control-request-method': 'POST',
      'access-control-request-headers': 'content-type,x-csrf-token',
    },
  });
  assert.equal(preflight.status, 200);
  assert.equal(await preflight.text(), '');
  assert.deepEqual(f.readReceipts, []);
  assert.equal(f.cursors.size, 0);
  assert.equal(f.messages.listUserMentionRequests('default-user').length, 2);
  const session = await fetch(base + '/api/session', { headers: { origin } });
  const principal = await session.json();
  const ownerHeaders = { cookie: session.headers.get('set-cookie').split(';')[0] };
  const mentionsPath = '/api/concierge/work/decisions?view=unified&includeUserMentions=true';
  const pending = await (await fetch(base + mentionsPath, { headers: ownerHeaders })).json();
  for (const original of [f.inbox, f.sidebar]) {
    const row = pending.items.find((item) => item.userMention?.messageId === original.message.id);
    assert.equal(row?.userMention.threadTitle, original.thread.title, 'original owner read supplies the name');
  }
  const response = await fetch(base + route, {
    method: 'POST',
    headers: {
      origin,
      cookie: session.headers.get('set-cookie').split(';')[0],
      'content-type': 'application/json',
      'x-csrf-token': principal.csrfToken,
    },
    body: '{}',
  });
  assert.equal(response.status, 200);
  const receipt = await response.json();
  assert.equal(receipt.caughtUp, true);
  assert.equal(receipt.handledMention, true);
  assert.equal(f.readReceipts.length, 1);
  assert.equal(f.messages.getUserMentionHandlingMetadata('default-user')[f.inbox.message.id].reason, 'viewed');
  const handled = await (await fetch(base + mentionsPath + '&mentionPeriod=handled', { headers: ownerHeaders })).json();
  const history = handled.items.find((item) => item.userMention?.messageId === f.inbox.message.id);
  assert.equal(history?.userMention.threadTitle, f.inbox.thread.title);
  assert.equal(history?.userMention.handledReason, 'viewed');
  assert.equal(f.messages.listUserMentionRequests('default-user')[0].id, f.sidebar.message.id);
  assert.equal(f.messages.listUserMentionRequests('other-owner')[0].id, f.foreign.message.id);
  const summaries = await f.readStateStore.getUnreadSummaries(
    'default-user',
    [f.inbox.thread.id, f.sidebar.thread.id],
    f.messages,
  );
  assert.equal(summaries.find((r) => r.threadId === f.inbox.thread.id).hasUserMention, false);
  assert.equal(summaries.find((r) => r.threadId === f.sidebar.thread.id).hasUserMention, true);
  assert.equal(
    f.records.every((r) => f.proposals.get(r.proposalId).status === 'pending'),
    true,
  );
});
