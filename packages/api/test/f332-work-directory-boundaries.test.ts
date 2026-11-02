import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCatId, type TaskItem } from '@cat-cafe/shared';
import { fixture } from './helpers/f332-directory-fixture.js';

test('directory Task and project details require the exact invocation authority of list-tasks', async (t) => {
  const f = await fixture(t);
  const home = f.threadStore.create('owner', 'visible title', '/home/user/secret-project');
  const child = f.threadStore.create('owner', 'visible execution title');
  const own = f.taskStore.create({
    threadId: home.id,
    title: 'CONFIDENTIAL TASK TITLE',
    why: '',
    createdBy: 'user',
    userId: 'owner',
    ownerCatId: createCatId('opus55'),
    dispatchGate: { status: 'dispatched', dispatchedThreadId: child.id },
  });
  f.taskStore.create({ threadId: home.id, title: 'FOREIGN USER TASK', why: '', createdBy: 'user', userId: 'stranger' });
  f.taskStore.create({ threadId: home.id, title: 'LEGACY WITHOUT USER', why: '', createdBy: 'user' });
  const key = await f.agentKeyRegistry.issue(createCatId('codex61-sol'), 'owner', { expiresAt: null });
  const headers = { 'x-agent-key-secret': key.secret };
  assert.equal((await f.app.inject({ url: `/api/callbacks/list-tasks?threadId=${home.id}`, headers })).statusCode, 401);
  const response = await f.app.inject({ url: '/api/callbacks/list-threads?includeWork=true', headers });
  assert.equal(response.statusCode, 200);
  const entry = response.json().threads.find((row: { threadId: string }) => row.threadId === home.id);
  assert.deepEqual(entry.recentTasks, { status: 'unavailable', reason: 'not_authorized' });
  assert.equal(entry.projectPath, null);
  assert.equal(entry.projectPathStatus, 'not_authorized');
  assert.doesNotMatch(
    response.body,
    /CONFIDENTIAL|FOREIGN USER|LEGACY WITHOUT|opus55|\/Users\/owner\/secret-project|dispatchedThreadId/,
  );
  const full = await f.app.inject({ url: '/api/callbacks/list-threads?includeWork=true', headers: f.headers });
  const detail = full.json().threads.find((row: { threadId: string }) => row.threadId === home.id);
  assert.equal(detail.projectPath, home.projectPath);
  assert.deepEqual(
    detail.recentTasks.items.map((task: { id: string }) => task.id),
    [own.id],
  );
  assert.equal(detail.recentTasks.items[0].kind, 'work');
  const drill = await f.app.inject({
    url: `/api/callbacks/list-tasks?threadId=${home.id}&taskId=${own.id}`,
    headers: f.headers,
  });
  assert.equal(drill.json().tasks[0].id, own.id);
  assert.doesNotMatch(full.body, /FOREIGN USER|LEGACY WITHOUT/);
});

test('entrusted work without a verified execution link cannot turn no home run into no line execution', async (t) => {
  const f = await fixture(t);
  const home = f.threadStore.create('owner', 'command line', process.cwd());
  const child = f.threadStore.create('owner', 'execution line', process.cwd());
  const task = f.taskStore.create({
    threadId: home.id,
    title: 'entrusted work',
    why: '',
    userId: 'owner',
    createdBy: 'user',
    ownerCatId: createCatId('codex61-sol'),
  });
  const entrustedWork = {
    revision: 1,
    admission: {
      basis: 'explicit_entrustment',
      sourceRefs: ['message:accepted'],
      idempotencyKey: 'fixture',
      receiptRef: 'task:receipt:fixture:1',
      admittedAt: 100,
    },
    intendedOutcome: 'read the original work line',
    time: {},
    artifactRefs: [],
    closure: { condition: 'complete accepted work', expectedSignal: 'terminal_report', state: 'open' },
  } satisfies NonNullable<TaskItem['entrustedWork']>;
  f.taskStore.listByThreadPage = (id) => ({
    tasks: id === home.id ? [{ ...task, status: 'doing', entrustedWork }] : [],
  });
  f.executions.push({
    threadId: child.id,
    threadTitle: child.title ?? '',
    catId: 'codex61-sol',
    kind: 'live_invocation',
    startedAt: 100,
    cancelability: { state: 'cancelable' },
  });
  const response = await f.app.inject({ url: '/api/callbacks/list-threads?includeWork=true', headers: f.headers });
  const entry = response.json().threads.find((row: { threadId: string }) => row.threadId === home.id);
  assert.equal(entry.execution.state, 'unknown');
  assert.equal(entry.execution.reason, 'task_execution_links_incomplete');
  f.executions.push({ ...f.executions[0], threadId: home.id });
  const direct = await f.app.inject({ url: '/api/callbacks/list-threads?includeWork=true', headers: f.headers });
  assert.equal(
    direct.json().threads.find((row: { threadId: string }) => row.threadId === home.id).execution.state,
    'running',
  );
});

test('a slow runtime source expires independently while healthy Task reads remain available', async (t) => {
  const f = await fixture(t, { sourceDelayMs: 3500 });
  const home = f.threadStore.create('owner', 'healthy tasks', process.cwd());
  const task = f.taskStore.create({
    threadId: home.id,
    title: 'real work',
    why: '',
    userId: 'owner',
    createdBy: 'user',
  });
  const response = await f.app.inject({ url: '/api/callbacks/list-threads?includeWork=true', headers: f.headers });
  const entry = response.json().threads[0];
  assert.equal(entry.recentTasks.status, 'available');
  assert.equal(entry.recentTasks.items[0].id, task.id);
  assert.equal(entry.execution.state, 'unknown');
  assert.equal(entry.execution.reason, 'budget_exhausted');
});

test('a dispatch routing target cannot certify the execution link of entrusted work', async (t) => {
  const f = await fixture(t);
  const home = f.threadStore.create('owner', 'command line', process.cwd());
  const routed = f.threadStore.create('owner', 'feature destination', process.cwd());
  const actual = f.threadStore.create('owner', 'independent execution', process.cwd());
  const task = f.taskStore.create({
    threadId: home.id,
    title: 'entrusted and routed',
    why: '',
    userId: 'owner',
    createdBy: 'user',
    dispatchGate: { status: 'dispatched', dispatchedThreadId: routed.id },
  });
  const entrustedWork = {
    revision: 1,
    admission: {
      basis: 'explicit_entrustment',
      sourceRefs: ['message:accepted'],
      idempotencyKey: 'fixture-routing',
      receiptRef: 'task:receipt:routing:1',
      admittedAt: 100,
    },
    intendedOutcome: 'read original work',
    time: {},
    artifactRefs: [],
    closure: { condition: 'complete work', expectedSignal: 'terminal_report', state: 'open' },
  } satisfies NonNullable<TaskItem['entrustedWork']>;
  f.taskStore.listByThreadPage = (id) => ({ tasks: id === home.id ? [{ ...task, entrustedWork }] : [] });
  f.executions.push({
    threadId: actual.id,
    threadTitle: actual.title ?? '',
    catId: 'codex61-sol',
    kind: 'live_invocation',
    startedAt: 100,
    cancelability: { state: 'cancelable' },
  });
  const response = await f.app.inject({ url: '/api/callbacks/list-threads?includeWork=true', headers: f.headers });
  const entry = response.json().threads.find((row: { threadId: string }) => row.threadId === home.id);
  assert.equal(entry.execution.state, 'unknown');
  assert.equal(entry.execution.reason, 'task_execution_links_incomplete');
  assert.equal(entry.recentTasks.items[0].dispatchedThreadId, routed.id);
  assert.equal('executionThreadId' in entry.recentTasks.items[0], false);
});
