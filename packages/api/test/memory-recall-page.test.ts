import assert from 'node:assert/strict';
import { test } from 'node:test';
import { recallFixture } from './memory-recall-fixture.js';

test('selected window, source and cat use real ledger rows with both time bounds', async () => {
  const f = await recallFixture();
  try {
    f.recall('new');
    f.recall('old', { timestamp: f.now - 10 * 86400000 });
    f.recall('future', { timestamp: f.now + 60000 });
    f.recall('push', { source: 'push', cat: 'kimi' });
    const body = (await f.get('?days=7')).json();
    assert.equal(body.days, 7);
    assert.equal(body.records.length, 2);
    assert.deepEqual(
      (await f.get('?days=14&source=pull'))
        .json()
        .records.map((row: { event: { id: string } }) => row.event.id)
        .sort(),
      ['new', 'old'],
    );
    assert.deepEqual(
      (await f.get('?source=push&catId=kimi')).json().records.map((row: { event: { id: string } }) => row.event.id),
      ['push'],
    );
    assert.equal((await f.get('?catId=sonnet')).json().records.length, 1);
  } finally {
    await f.close();
  }
});

test('owner session is required and all malformed filters fail closed', async () => {
  const f = await recallFixture();
  try {
    for (const path of ['/api/memory/recall', '/api/memory/recall/stats']) {
      assert.equal((await f.app.inject({ url: path })).statusCode, 401);
      assert.equal((await f.app.inject({ url: path, headers: { 'x-cat-cafe-user': 'owner' } })).statusCode, 401);
      assert.equal((await f.app.inject({ url: path, headers: { 'x-test-session': 'other-owner' } })).statusCode, 403);
    }
    for (const query of ['days=8', 'source=other', 'limit=0', 'limit=101', 'catId=', 'threadId=own', 'cursor=garbage'])
      assert.equal((await f.get(`?${query}`)).statusCode, 400, query);
  } finally {
    await f.close();
  }
});

test('canonical thread revalidation excludes foreign, deleted and unindexed system data', async () => {
  const f = await recallFixture();
  try {
    f.indexed.push('other', 'deleted', 'missing', 'system', 'own');
    for (const thread of ['own', 'other', 'deleted', 'system', 'unindexed']) f.recall(`r-${thread}`, { thread });
    const response = await f.get();
    assert.equal(response.statusCode, 200);
    assert.deepEqual(
      response
        .json()
        .records.map((row: { threadId: string }) => row.threadId)
        .sort(),
      ['own', 'system'],
    );
    assert.equal(response.body.includes('秘密标题'), false);
    assert.ok(f.replyReads.every((read) => read.owner === 'owner' && ['own', 'system'].includes(read.threadId)));
  } finally {
    await f.close();
  }
});

test('pagination freezes its upper bound, handles ties and rejects filter changes or tampering', async () => {
  const f = await recallFixture();
  try {
    for (const id of ['a', 'b', 'c']) f.recall(id);
    const first = (await f.get('?limit=1')).json();
    assert.equal(first.records[0].event.id, 'c');
    assert.ok(first.nextCursor);
    f.recall('later', { timestamp: first.to + 1 });
    const second = (await f.get(`?limit=1&cursor=${encodeURIComponent(first.nextCursor)}`)).json();
    assert.equal(second.records[0].event.id, 'b');
    assert.equal(second.to, first.to);
    const third = (await f.get(`?limit=1&cursor=${encodeURIComponent(second.nextCursor)}`)).json();
    assert.equal(third.records[0].event.id, 'a');
    assert.equal(third.nextCursor, null);
    for (const query of [
      `days=14&cursor=${first.nextCursor}`,
      `source=push&cursor=${first.nextCursor}`,
      `catId=kimi&cursor=${first.nextCursor}`,
      `cursor=x${first.nextCursor}`,
    ])
      assert.equal((await f.get(`?${query}`)).statusCode, 400);
  } finally {
    await f.close();
  }
});

test('malformed rows and unavailable reply readers yield partial, never false empty', async () => {
  const f = await recallFixture((readers) => {
    readers.messageStore = undefined;
  });
  try {
    f.recall('good');
    f.recall('malformed', { candidates: '{}' });
    const body = (await f.get()).json();
    assert.equal(body.readStatus, 'partial');
    assert.equal(body.records.length, 1);
    f.db.prepare('DELETE FROM recall_events WHERE recall_id = ?').run('good');
    const partialEmpty = (await f.get()).json();
    assert.equal(partialEmpty.readStatus, 'partial');
    assert.equal(partialEmpty.records.length, 0);
    f.db.prepare('DELETE FROM recall_events').run();
    assert.equal((await f.get()).json().readStatus, 'ready');
  } finally {
    await f.close();
  }
});

test('missing root readers return unavailable, and reply projection contains coordinates only', async () => {
  const missing = await recallFixture((readers) => {
    readers.threadStore = undefined;
  });
  try {
    assert.equal((await missing.get()).statusCode, 503);
  } finally {
    await missing.close();
  }
  const f = await recallFixture();
  try {
    f.recall('good');
    f.replies.set('own', [
      {
        id: 'reply',
        catId: 'sonnet',
        timestamp: f.now,
        extra: { stream: { invocationId: 'parent', turnInvocationId: 'child' } },
      },
      {
        id: 'explicit-post',
        catId: 'sonnet',
        timestamp: f.now,
        extra: { isExplicitPost: true, stream: { invocationId: 'parent' } },
      },
    ]);
    const body = (await f.get()).json();
    assert.deepEqual(body.replies, [
      {
        threadId: 'own',
        messageId: 'reply',
        catId: 'sonnet',
        timestamp: f.now,
        invocationId: 'child',
        parentInvocationId: 'parent',
      },
    ]);
    assert.deepEqual(Object.keys(body.replies[0]).sort(), [
      'catId',
      'invocationId',
      'messageId',
      'parentInvocationId',
      'threadId',
      'timestamp',
    ]);
  } finally {
    await f.close();
  }
});

test('window stats retain ledger units and exclude stale index entries and future timestamps', async () => {
  const f = await recallFixture();
  try {
    f.indexed.push('other', 'deleted');
    f.recall('own', { inspected: 1 });
    f.recall('push', { source: 'push' });
    f.recall('old', { timestamp: f.now - 10 * 86400000 });
    f.recall('future', { timestamp: f.now + 60000 });
    f.recall('foreign', { thread: 'other' });
    f.recall('deleted', { thread: 'deleted' });
    const read = (days: number) =>
      f.app.inject({ url: `/api/memory/recall/stats?days=${days}`, headers: { 'x-test-session': 'owner' } });
    const body = (await read(7)).json();
    assert.equal(body.rows.find((row: { source: string }) => row.source === 'pull').presented, 1);
    assert.equal(body.rows.find((row: { source: string }) => row.source === 'pull').inspected, 1);
    assert.equal(body.rows.find((row: { source: string }) => row.source === 'push').presented, 1);
    assert.equal((await read(14)).json().rows.find((row: { source: string }) => row.source === 'pull').presented, 2);
    assert.equal((await read(8)).statusCode, 400);
  } finally {
    await f.close();
  }
});
