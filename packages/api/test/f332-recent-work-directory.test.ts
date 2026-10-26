import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCatId } from '@cat-cafe/shared';
import { fixture } from './helpers/f332-directory-fixture.js';

test('work directory identifies the line, keeps taskless threads, and never infers execution from doing', async (t) => {
  const f = await fixture(t);
  const line = f.threadStore.create('owner', '3D 宪宪喵建模', process.cwd());
  const empty = f.threadStore.create('owner', '还没有毛线球的故事', '/projects/stories');
  f.threadStore.create('stranger', 'PRIVATE THREAD', '/private');
  const tasks = Array.from({ length: 5 }, (_, i) => {
    const task = f.taskStore.create({
      threadId: line.id,
      title: `work ${i}`,
      why: '',
      ownerCatId: createCatId('opus55'),
      createdBy: 'user',
      userId: 'owner',
    });
    f.taskStore.update(task.id, { status: i === 4 ? 'done' : 'doing' });
    return task;
  });
  const snapshots = tasks.map((task, i) => ({ ...f.taskStore.get(task.id)!, updatedAt: 100 + i }));
  f.taskStore.listByThreadPage = (threadId) => ({ tasks: threadId === line.id ? snapshots : [], scannedCount: 5 });
  const response = await f.app.inject({ url: '/api/callbacks/list-threads?includeWork=true', headers: f.headers });
  assert.equal(response.statusCode, 200, response.body);
  const body = response.json();
  const entry = body.threads.find((item: { threadId: string }) => item.threadId === line.id);
  assert.equal(entry.title, '3D 宪宪喵建模');
  assert.equal(entry.projectPath, process.cwd());
  assert.equal(entry.recentTasks.status, 'available');
  assert.equal(entry.recentTasks.items.length, 3);
  assert.equal(entry.recentTasks.unfinishedTotal, 4);
  assert.deepEqual(
    entry.recentTasks.items.map((task: { id: string }) => task.id),
    [tasks[3]!.id, tasks[2]!.id, tasks[1]!.id],
  );
  assert.ok(
    entry.recentTasks.items.every(
      (task: { status: string; id: string }) => task.status === 'doing' && task.id !== tasks[4]!.id,
    ),
  );
  assert.equal(entry.execution.status, 'available');
  assert.deepEqual(entry.execution.runningCatIds, []);
  assert.deepEqual(entry.drillDown, { tool: 'cat_cafe_get_thread_context', args: { threadId: line.id } });
  assert.deepEqual(body.threads.find((item: { threadId: string }) => item.threadId === empty.id).recentTasks.items, []);
  assert.equal(
    body.threads.find((item: { threadId: string }) => item.threadId === empty.id).execution.reason,
    'outside_host_project',
  );
  assert.doesNotMatch(response.body, /PRIVATE THREAD|"projectPath":"\/private"/);
});

test('shared indexed threads keep narrower Task visibility while reusing authorized execution projection', async (t) => {
  const f = await fixture(t);
  const shared = f.threadStore.create('system', 'shared surface', process.cwd());
  f.threadStore.indexForUser(shared.id, 'owner');
  for (const userId of ['owner', 'stranger']) {
    f.taskStore.create({
      threadId: shared.id,
      title: userId === 'owner' ? 'my work' : 'SECRET WORK',
      why: '',
      userId,
      createdBy: 'user',
    });
  }
  f.executions.push({
    threadId: shared.id,
    threadTitle: 'shared surface',
    catId: 'codex61-sol',
    kind: 'live_invocation',
    startedAt: 100,
    cancelability: { state: 'cancelable' },
  });
  const response = await f.app.inject({ url: '/api/callbacks/list-threads?includeWork=true', headers: f.headers });
  assert.equal(response.statusCode, 200, response.body);
  const entry = response.json().threads.find((item: { threadId: string }) => item.threadId === shared.id);
  assert.deepEqual(
    entry.recentTasks.items.map((task: { title: string }) => task.title),
    ['my work'],
  );
  assert.deepEqual(entry.execution.runningCatIds, ['codex61-sol']);
  assert.doesNotMatch(response.body, /SECRET WORK|opus55|run-stranger/);
});

test('large task histories and response payloads stop at the declared budget and retain honest continuation', async (t) => {
  const f = await fixture(t);
  for (let i = 0; i < 30; i++) {
    const thread = f.threadStore.create('owner', `line ${i} ${'t'.repeat(190)}`);
    for (let n = 0; n < 4; n++)
      f.taskStore.create({
        threadId: thread.id,
        title: 'work '.repeat(70),
        why: '',
        createdBy: 'user',
        userId: 'owner',
      });
  }
  const page = await f.app.inject({
    url: '/api/callbacks/list-threads?includeWork=true&limit=200',
    headers: f.headers,
  });
  assert.equal(page.statusCode, 200);
  assert.ok(page.body.length <= 24000);
  assert.ok(page.json().threads.length <= 20);
  assert.ok(page.json().nextCursor);
  let reads = 0;
  f.taskStore.listByThreadPage = () => {
    reads++;
    return { tasks: [], scannedCount: 100, nextCursor: `page-${reads}` };
  };
  const partial = await f.app.inject({
    url: '/api/callbacks/list-threads?includeWork=true&limit=1',
    headers: f.headers,
  });
  assert.equal(reads, 5);
  assert.equal(partial.json().threads[0].recentTasks.status, 'partial');
  assert.equal(partial.json().threads[0].recentTasks.order, 'updatedAt_desc_within_read');
});

test('opening navigation offers a one-hop directory without preloading another conversation', async () => {
  const { formatNavigationHeader } = await import('../src/domains/cats/services/agents/routing/navigation-context.js');
  const text = formatNavigationHeader({ baton: null, tasks: [], recentWorkDirectory: true });
  assert.match(text, /cat_cafe_list_threads\(\{ includeWork: true/);
  assert.doesNotMatch(text, /SECRET WORK|work 0/);
});

test('runtime unavailability remains unknown while titles and tasks survive', async (t) => {
  const f = await fixture(t, { sourceDown: true });
  const thread = f.threadStore.create('owner', 'still discoverable');
  const response = await f.app.inject({ url: '/api/callbacks/list-threads?includeWork=true', headers: f.headers });
  assert.equal(response.statusCode, 200);
  const entry = response.json().threads.find((item: { threadId: string }) => item.threadId === thread.id);
  assert.equal(entry.execution.status, 'unavailable');
  assert.equal('runningCatIds' in entry.execution, false);
  assert.equal(entry.recentTasks.status, 'available');
});

test('agent-key directory discovery cannot borrow invocation-only running-work authority', async (t) => {
  const f = await fixture(t);
  const key = await f.agentKeyRegistry.issue(createCatId('codex61-sol'), 'owner', { expiresAt: null });
  const thread = f.threadStore.create('owner', 'agent visible', process.cwd());
  f.executions.push({
    threadId: thread.id,
    threadTitle: thread.title!,
    catId: 'opus55',
    kind: 'live_invocation',
    startedAt: 100,
    cancelability: { state: 'cancelable' },
  });
  const response = await f.app.inject({
    url: '/api/callbacks/list-threads?includeWork=true',
    headers: { 'x-agent-key-secret': key.secret },
  });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json().threads[0].execution.state, 'unknown');
  assert.equal(response.json().threads[0].execution.reason, 'not_authorized');
  assert.doesNotMatch(response.body, /opus55/);
});

test('a dispatched Task finds its visible execution thread even outside the three shown Tasks', async (t) => {
  const f = await fixture(t);
  const home = f.threadStore.create('owner', 'work home', process.cwd());
  const child = f.threadStore.create('owner', 'actual execution', process.cwd());
  const task = f.taskStore.create({
    threadId: home.id,
    title: 'delegated original work',
    why: '',
    createdBy: 'user',
    userId: 'owner',
    dispatchGate: { status: 'dispatched', dispatchedThreadId: child.id },
  });
  const tasks = [
    { ...task, updatedAt: 1 },
    ...Array.from({ length: 3 }, (_, i) => ({ ...task, id: `newer-${i}`, updatedAt: 10 + i, dispatchGate: undefined })),
  ];
  f.taskStore.listByThreadPage = (id) => ({ tasks: id === home.id ? tasks : [], scannedCount: tasks.length });
  f.executions.push({
    threadId: child.id,
    threadTitle: child.title!,
    catId: 'opus55',
    kind: 'managed_command',
    startedAt: 100,
    cancelability: { state: 'cancelable' },
  });
  const response = await f.app.inject({ url: '/api/callbacks/list-threads?includeWork=true', headers: f.headers });
  assert.equal(response.statusCode, 200, response.body);
  const entry = response.json().threads.find((item: { threadId: string }) => item.threadId === home.id);
  assert.deepEqual(entry.execution.runningCatIds, ['opus55']);
  assert.equal(entry.execution.state, 'running');
});

test('work title search does not drown short words in random thread ID matches', async (t) => {
  const f = await fixture(t);
  const thread = f.threadStore.create('owner', 'unrelated line');
  thread.id = 'thread_noise3d';
  const noise = await f.app.inject({
    url: '/api/callbacks/list-threads?includeWork=true&keyword=3D',
    headers: f.headers,
  });
  assert.deepEqual(noise.json().threads, []);
  const exact = await f.app.inject({
    url: '/api/callbacks/list-threads?includeWork=true&keyword=thread_noise3d',
    headers: f.headers,
  });
  assert.equal(exact.json().threads[0].threadId, thread.id);
});

test('directory pagination is bounded and rejects a cursor reused under another selector', async (t) => {
  const f = await fixture(t);
  for (let i = 0; i < 24; i++) f.threadStore.create('owner', `line ${i}`);
  const first = await f.app.inject({ url: '/api/callbacks/list-threads?includeWork=true&limit=2', headers: f.headers });
  assert.equal(first.statusCode, 200);
  const page = first.json();
  assert.equal(page.threads.length, 2);
  assert.equal(page.hasMore, true);
  assert.ok(page.nextCursor);
  assert.ok(first.body.length <= 24000);
  const next = await f.app.inject({
    url: `/api/callbacks/list-threads?includeWork=true&limit=2&cursor=${encodeURIComponent(page.nextCursor)}`,
    headers: f.headers,
  });
  assert.equal(next.statusCode, 200);
  assert.ok(
    next
      .json()
      .threads.every(
        (entry: { threadId: string }) =>
          !page.threads.some((old: { threadId: string }) => old.threadId === entry.threadId),
      ),
  );
  const changed = await f.app.inject({
    url: `/api/callbacks/list-threads?includeWork=true&keyword=other&cursor=${encodeURIComponent(page.nextCursor)}`,
    headers: f.headers,
  });
  assert.equal(changed.statusCode, 400);
  const denied = await f.app.inject('/api/callbacks/list-threads?includeWork=true');
  assert.equal(denied.statusCode, 401);
});

test('a failed Task source and an oversized project coordinate retain a bounded title pointer', async (t) => {
  const f = await fixture(t);
  f.threadStore.create('owner', 'still reachable by thread', 'x'.repeat(30000));
  f.taskStore.listByThreadPage = () => {
    throw new Error('task source down');
  };
  const response = await f.app.inject({ url: '/api/callbacks/list-threads?includeWork=true', headers: f.headers });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json().threads[0].recentTasks.status, 'unavailable');
  assert.equal(response.json().threads[0].projectPath, null);
  assert.ok(response.body.length <= 24000);
  assert.equal(response.json().hasMore, false);
});
