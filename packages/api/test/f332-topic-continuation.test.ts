import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixture } from './helpers/f332-directory-fixture.js';

const url = (topic: string, cursor?: string) =>
  `/api/callbacks/list-threads?${new URLSearchParams({
    includeWork: 'true',
    topic,
    ...(cursor ? { cursor } : {}),
  })}`;

test('every accepted topic delimiter carries the same clues into the original full read', async (t) => {
  const f = await fixture(t);
  const thread = f.threadStore.create('owner', '机器人系列读论文');
  const original = f.messageStore.append({
    userId: 'owner',
    threadId: thread.id,
    from: { kind: 'user', userId: 'owner' },
    content: '机器人影片先解释问题，再解释方法。',
    mentions: [],
    timestamp: Date.now(),
  });
  for (const topic of ['机器人 影片', '机器人，影片', '机器人、影片', '机器人,影片']) {
    const directory = await f.app.inject({ url: url(topic), headers: f.headers });
    const pointer = directory.json().threads[0].readNext;
    const read = await f.app.inject({
      url: `/api/callbacks/thread-context?${new URLSearchParams(pointer.args)}`,
      headers: f.headers,
    });
    assert.equal(read.statusCode, 200, read.body);
    assert.ok(
      read
        .json()
        .messages.some(
          (m: { id: string; content: string; truncated: boolean }) =>
            m.id === original.id && m.content === original.content && !m.truncated,
        ),
      topic,
    );
  }
});

test('a Task read interrupted by the actual page budget stays on the continuation, even at position zero', async (t) => {
  for (const withEarlierThread of [true, false])
    await t.test(`earlierThread=${withEarlierThread}`, async (st) => {
      const f = await fixture(st);
      if (withEarlierThread) f.threadStore.create('owner', '线程A').lastActiveAt = 300;
      const original = f.threadStore.create('owner', '线程B');
      original.lastActiveAt = 200;
      f.threadStore.create('owner', '线程C').lastActiveAt = 100;
      const hit = f.taskStore.create({
        threadId: original.id,
        title: '机器人影片',
        why: '',
        createdBy: 'user',
        userId: 'owner',
      });
      f.taskStore.update(hit.id, { status: 'done' });
      const readPage = f.taskStore.listByThreadPage.bind(f.taskStore);
      f.taskStore.listByThreadPage = (id, ...args) =>
        id === original.id
          ? new Promise(() => {}) // No timer/process remains after the production abort.
          : readPage(id, ...args);
      const interrupted = await f.app.inject({ url: url('机器人'), headers: f.headers });
      const page = interrupted.json();
      assert.equal(interrupted.statusCode, 200, interrupted.body);
      assert.equal(page.discovery.coverage.reason, 'budget_exhausted');
      assert.equal(page.discovery.coverage.complete, false);
      assert.ok(page.nextCursor, 'an interrupted first thread must retain an original-read continuation');
      f.taskStore.listByThreadPage = readPage;
      const resumed = await f.app.inject({ url: url('机器人', page.nextCursor), headers: f.headers });
      assert.equal(resumed.statusCode, 200, resumed.body);
      assert.equal(resumed.json().threads[0]?.threadId, original.id, 'resume must not skip the unread Task');
      assert.equal(resumed.json().threads[0].matchingTasks[0].id, hit.id);
    });
});

test('a later page retains an earlier source gap instead of declaring complete metadata coverage', async (t) => {
  const f = await fixture(t);
  const first = f.threadStore.create('owner', '机器人先前来源');
  first.lastActiveAt = 300;
  const second = f.threadStore.create('owner', '机器人后页来源');
  second.lastActiveAt = 200;
  const readPage = f.taskStore.listByThreadPage.bind(f.taskStore);
  f.taskStore.listByThreadPage = (id, ...args) => {
    if (id === first.id) throw new Error('original source unavailable');
    return readPage(id, ...args);
  };
  const page = (await f.app.inject({ url: `${url('机器人')}&limit=1`, headers: f.headers })).json();
  assert.equal(page.discovery.coverage.complete, false);
  const next = await f.app.inject({ url: `${url('机器人', page.nextCursor)}&limit=1`, headers: f.headers });
  assert.equal(next.json().hasMore, false);
  assert.equal(next.json().discovery.coverage.complete, false);
  assert.equal(next.json().discovery.coverage.priorPagesPartial, true);
});
