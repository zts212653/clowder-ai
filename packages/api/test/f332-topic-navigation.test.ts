import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { createCatId } from '@cat-cafe/shared';
import { fixture } from './helpers/f332-directory-fixture.js';

const url = (topic: string, extra = '') =>
  `/api/callbacks/list-threads?includeWork=true&topic=${encodeURIComponent(topic)}${extra}`;

test('an explicit topic finds a completed Task behind a different thread title without a Matter page', async (t) => {
  const f = await fixture(t);
  const original = f.threadStore.create('owner', '周三一起做的事情');
  const task = f.taskStore.create({
    threadId: original.id,
    title: '机器人论文讲解影片',
    why: '',
    createdBy: 'user',
    userId: 'owner',
  });
  f.taskStore.update(task.id, { status: 'done' });
  const unrelated = f.threadStore.create('owner', '今天的社区维护');
  original.lastActiveAt = 100;
  unrelated.lastActiveAt = 200;
  const response = await f.app.inject({ url: url('机器人 讲解', '&limit=1'), headers: f.headers });
  assert.equal(response.statusCode, 200, response.body);
  const body = response.json();
  assert.equal(body.threads[0]?.threadId, original.id);
  assert.equal(body.threads[0].topicMatch.method, 'literal_metadata');
  assert.equal(body.threads[0].topicMatch.originalContentRead, false);
  assert.equal(body.threads[0].matchingTasks[0].id, task.id);
  assert.equal(body.threads[0].matchingTasks[0].status, 'done');
  assert.deepEqual(body.threads[0].recentTasks.items, []);
  assert.equal(body.threads[0].readNext.args.responseMode, 'full');
  const drill = await f.app.inject({
    url: `/api/callbacks/list-tasks?threadId=${original.id}&taskId=${task.id}`,
    headers: f.headers,
  });
  assert.equal(drill.json().tasks[0].id, task.id);
});

test('topic clues match separately while a title substring remains an explicit narrow selector', async (t) => {
  const f = await fixture(t);
  const original = f.threadStore.create('owner', '机器人系列读论文');
  f.threadStore.create('owner', '无关的周报');
  const narrow = await f.app.inject({
    url: '/api/callbacks/list-threads?includeWork=true&keyword=机器人影片',
    headers: f.headers,
  });
  assert.deepEqual(narrow.json().threads, []);
  const found = await f.app.inject({ url: url('机器人 影片'), headers: f.headers });
  assert.deepEqual(
    found.json().threads.map((row: { threadId: string }) => row.threadId),
    [original.id],
  );
  assert.deepEqual(found.json().threads[0].topicMatch.sources, ['thread_title']);
  assert.equal(found.json().discovery.originalContentRead, false);
});

test('no match preserves a bounded continuation, weak original-thread pointers and uninspected Work entry', async (t) => {
  const f = await fixture(t);
  const original = f.threadStore.create('owner', '机器人实验');
  original.lastActiveAt = 1;
  for (let i = 0; i < 45; i++) {
    const thread = f.threadStore.create('owner', `其他事情 ${i}`);
    thread.lastActiveAt = 100 + i;
  }
  const response = await f.app.inject({ url: url('机器人'), headers: f.headers });
  const body = response.json();
  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(body.threads, []);
  assert.equal(body.hasMore, true);
  assert.equal(body.discovery.state, 'no_match_in_checked_scope');
  assert.equal(body.discovery.coverage.threadsScanned, 40);
  assert.equal(body.discovery.coverage.complete, false);
  assert.ok(body.fallbackThreads[0].drillDown.args.threadId);
  assert.equal(body.discovery.coverage.works, 'not_checked');
  assert.ok(body.nextSources.some((source: { tool: string }) => source.tool === 'cat_cafe_work'));
  assert.doesNotMatch(response.body, /untracked|从未发生|全库没有/);
  const next = await f.app.inject({
    url: url('机器人', `&cursor=${encodeURIComponent(body.nextCursor)}`),
    headers: f.headers,
  });
  assert.equal(next.json().threads[0]?.threadId, original.id);
  const mismatch = await f.app.inject({
    url: url('别的主题', `&cursor=${encodeURIComponent(body.nextCursor)}`),
    headers: f.headers,
  });
  assert.equal(mismatch.statusCode, 400);
});

test('topic discovery cannot borrow Task authority or leak another owner through a shared thread', async (t) => {
  const f = await fixture(t);
  const shared = f.threadStore.create('system', '普通共享标题');
  f.threadStore.indexForUser(shared.id, 'owner');
  f.taskStore.create({
    threadId: shared.id,
    title: 'SECRET 机器人影片',
    why: '',
    userId: 'stranger',
    createdBy: 'user',
  });
  f.taskStore.create({
    threadId: shared.id,
    title: 'PRIVATE 机器人影片',
    why: '',
    userId: 'owner',
    createdBy: 'user',
  });
  const key = await f.agentKeyRegistry.issue(createCatId('codex61-sol'), 'owner', { expiresAt: null });
  const denied = await f.app.inject({ url: url('机器人'), headers: { 'x-agent-key-secret': key.secret } });
  assert.equal(denied.statusCode, 200);
  assert.deepEqual(denied.json().threads, []);
  assert.equal(denied.json().discovery.coverage.tasks, 'not_authorized');
  assert.doesNotMatch(denied.body, /SECRET|PRIVATE/);
  const allowed = await f.app.inject({ url: url('机器人'), headers: f.headers });
  assert.equal(allowed.json().threads[0]?.matchingTasks[0].title, 'PRIVATE 机器人影片');
  assert.doesNotMatch(allowed.body, /SECRET/);
});

test('a failed Task source leaves the checked range partial while title candidates remain discoverable', async (t) => {
  const f = await fixture(t);
  const original = f.threadStore.create('owner', '机器人论文');
  f.taskStore.listByThreadPage = () => {
    throw new Error('source unavailable');
  };
  const response = await f.app.inject({ url: url('机器人'), headers: f.headers });
  assert.equal(response.json().threads[0]?.threadId, original.id);
  assert.equal(response.json().discovery.coverage.tasks, 'partial');
  assert.equal(response.json().discovery.coverage.complete, false);
  assert.equal(response.json().threads[0].topicMatch.originalContentRead, false);
});

test('an old title alone never makes the current prompt ask for work discovery', async () => {
  const { formatNavigationHeader } = await import('../src/domains/cats/services/agents/routing/navigation-context.js');
  const text = formatNavigationHeader({
    tasks: [],
    threadTitle: '机器人影片的新想法',
  });
  assert.doesNotMatch(text, /机器人影片的新想法|topic|cat_cafe_list_threads/);
});

test('legacy directory cursors remain valid when no new topic selector is present', async (t) => {
  const f = await fixture(t);
  f.threadStore.create('owner', 'first');
  f.threadStore.create('owner', 'second');
  const first = await f.app.inject({
    url: '/api/callbacks/list-threads?includeWork=true&limit=1',
    headers: f.headers,
  });
  const cursor = JSON.parse(Buffer.from(first.json().nextCursor, 'base64url').toString('utf8'));
  cursor.selector = createHash('sha256')
    .update(JSON.stringify(['owner', null, null]))
    .digest('hex');
  const next = await f.app.inject({
    url: `/api/callbacks/list-threads?includeWork=true&limit=1&cursor=${Buffer.from(JSON.stringify(cursor)).toString('base64url')}`,
    headers: f.headers,
  });
  assert.equal(next.statusCode, 200, next.body);
});

test('an unfiltered directory does not invent an executable evidence query', async (t) => {
  const f = await fixture(t);
  const response = await f.app.inject({ url: '/api/callbacks/list-threads?includeWork=true', headers: f.headers });
  const search = response
    .json()
    .nextSources.find((source: { tool: string }) => source.tool === 'cat_cafe_search_evidence');
  assert.equal(search.args, undefined);
  assert.match(search.requiredInput, /query/);
});

test('the returned original-read pointer reads full source messages and observes a later human correction', async (t) => {
  const f = await fixture(t);
  const thread = f.threadStore.create('owner', '机器人影片');
  const publish = (content: string) =>
    f.messageStore.append({
      userId: 'owner',
      threadId: thread.id,
      from: { kind: 'user', userId: 'owner' },
      content,
      mentions: [],
      timestamp: Date.now(),
    });
  const first = publish('机器人影片先解释问题，再解释方法。');
  const directory = await f.app.inject({ url: url('机器人'), headers: f.headers });
  const pointer = directory.json().threads[0].readNext;
  const read = () =>
    f.app.inject({
      url: `/api/callbacks/thread-context?${new URLSearchParams(pointer.args)}`,
      headers: f.headers,
    });
  const initial = await read();
  assert.equal(initial.statusCode, 200, initial.body);
  assert.ok(
    initial
      .json()
      .messages.some(
        (m: { id: string; content: string; truncated: boolean }) =>
          m.id === first.id && m.content === first.content && m.truncated === false,
      ),
  );
  const correction = publish('更正：机器人影片要先说明论文的问题设定和证据边界。');
  const current = await read();
  assert.ok(
    current
      .json()
      .messages.some(
        (m: { id: string; content: string; truncated: boolean }) =>
          m.id === correction.id && m.content === correction.content && m.truncated === false,
      ),
  );
});
