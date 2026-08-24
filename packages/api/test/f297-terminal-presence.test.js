/**
 * F297 regression — Sidebar terminal state requires a lifecycle witness.
 *
 * A historical cat response is conversation activity, not proof that an invocation
 * completed.  Only an authoritative InvocationRecord terminal transition may publish
 * done/error; incomplete knowledge stays idle.
 */

import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import Fastify from 'fastify';
import {
  load,
  realDeps,
  realPresenceSource,
  runningManagedCommandTask,
  startRunningRecordWithDraft,
} from './helpers/f297-presence-fixtures.js';

describe('F297 terminal presence semantics (C10 lifecycle witness)', () => {
  let threadStore;
  let app;

  beforeEach(async () => {
    const { ThreadStore } = await load('domains/cats/services/stores/ports/ThreadStore.js');
    threadStore = new ThreadStore();
  });

  async function sidebarRows({ projectedPresence = new Map(), presenceSource, unreadByThread = new Map() } = {}) {
    const { threadsRoutes } = await load('routes/threads.js');
    if (app) await app.close();
    app = Fastify();
    await app.register(threadsRoutes, {
      threadStore,
      presenceSource: presenceSource ?? { getPresence: async () => projectedPresence },
      messageStore: {},
      readStateStore: {
        getUnreadSummaries: (_userId, threadIds) =>
          threadIds.map((threadId) => ({
            threadId,
            unreadCount: unreadByThread.get(threadId) ?? 0,
            hasUserMention: false,
          })),
      },
    });
    await app.ready();
    const res = await app.inject({
      method: 'GET',
      url: '/api/threads?view=sidebar',
      headers: { 'x-cat-cafe-user': 'alice' },
    });
    assert.equal(res.statusCode, 200);
    const rows = JSON.parse(res.body).threads;
    await app.close();
    app = undefined;
    return new Map(rows.map((row) => [row.id, row]));
  }

  it('regression: a historical healthy response is idle without a terminal invocation witness', async () => {
    const thread = threadStore.create('alice', 'Historical response', '/p');
    threadStore.updateParticipantActivity(thread.id, 'opus5', true);

    const rows = await sidebarRows();
    assert.equal(rows.get(thread.id).presence.status, 'idle');
  });

  it('regression: a historical unhealthy response is idle without a terminal invocation witness', async () => {
    const thread = threadStore.create('alice', 'Historical error', '/p');
    threadStore.updateParticipantActivity(thread.id, 'opus5', false);

    const rows = await sidebarRows();
    assert.equal(rows.get(thread.id).presence.status, 'idle');
  });

  it('no response at all is idle, never done', async () => {
    const thread = threadStore.create('alice', 'Untouched', '/p');
    const rows = await sidebarRows();
    assert.equal(rows.get(thread.id).presence.status, 'idle');
  });

  it('active execution still overrides historical conversation activity', async () => {
    const thread = threadStore.create('alice', 'Running again', '/p');
    threadStore.updateParticipantActivity(thread.id, 'opus5', false);

    const rows = await sidebarRows({
      projectedPresence: new Map([[thread.id, { status: 'working', cats: ['opus5'] }]]),
    });
    assert.equal(rows.get(thread.id).presence.status, 'working');
  });

  it('an authoritative successful InvocationRecord publishes done for its exact successful cats', async () => {
    const deps = await realDeps();
    const created = await deps.recordStore.create({
      threadId: 'thread_terminal_success',
      userId: 'alice',
      targetCats: ['opus5'],
      intent: 'execute',
      idempotencyKey: 'terminal-success',
      actionLeaseCarrier: { kind: 'none' },
    });
    await deps.recordStore.update(created.invocationId, { status: 'running' });
    await deps.recordStore.update(created.invocationId, {
      status: 'succeeded',
      successfulCatIds: ['opus5'],
    });
    const { source } = await realPresenceSource(deps);

    const presence = await source.getPresence(['thread_terminal_success'], 'alice');
    assert.deepEqual(presence.get('thread_terminal_success'), { status: 'done', cats: ['opus5'] });
  });

  it('a new canonical running execution overrides an older successful lifecycle witness', async () => {
    const deps = await realDeps();
    const completed = await deps.recordStore.create({
      threadId: 'thread_running_again',
      userId: 'alice',
      targetCats: ['opus5'],
      intent: 'execute',
      idempotencyKey: 'older-terminal',
      actionLeaseCarrier: { kind: 'none' },
    });
    await deps.recordStore.update(completed.invocationId, { status: 'running' });
    await deps.recordStore.update(completed.invocationId, {
      status: 'succeeded',
      successfulCatIds: ['opus5'],
    });
    await startRunningRecordWithDraft(deps, {
      threadId: 'thread_running_again',
      userId: 'alice',
      catId: 'codex-sol',
    });
    const { source } = await realPresenceSource(deps);

    const presence = await source.getPresence(['thread_running_again'], 'alice');
    assert.equal(presence.get('thread_running_again')?.status, 'working');
    assert.deepEqual(presence.get('thread_running_again')?.cats, ['codex-sol']);
    assert.equal(
      typeof presence.get('thread_running_again')?.activeSince,
      'number',
      'canonical running execution carries elapsed-time authority',
    );
  });

  it('a successful terminal is visible only while the thread still needs attention', async () => {
    const thread = threadStore.create('alice', 'Completed invocation', '/p');
    const terminal = new Map([[thread.id, { status: 'done', cats: ['opus5'] }]]);

    const unread = await sidebarRows({
      projectedPresence: terminal,
      unreadByThread: new Map([[thread.id, 1]]),
    });
    assert.deepEqual(unread.get(thread.id).presence, { status: 'done', cats: ['opus5'] });

    const read = await sidebarRows({ projectedPresence: terminal });
    assert.deepEqual(read.get(thread.id).presence, { status: 'idle' }, 'opening/reading retires the terminal badge');
  });

  it('working remains visible even when unread is zero', async () => {
    const thread = threadStore.create('alice', 'Currently running', '/p');
    const rows = await sidebarRows({
      projectedPresence: new Map([[thread.id, { status: 'working', cats: ['opus5'] }]]),
    });
    assert.deepEqual(rows.get(thread.id).presence, { status: 'working', cats: ['opus5'] });
  });

  it('failed is lifecycle error, canceled clears terminal presentation', async () => {
    const deps = await realDeps();
    const failed = await deps.recordStore.create({
      threadId: 'thread_terminal_failure',
      userId: 'alice',
      targetCats: ['opus5'],
      intent: 'execute',
      idempotencyKey: 'terminal-failure',
      actionLeaseCarrier: { kind: 'none' },
    });
    await deps.recordStore.update(failed.invocationId, { status: 'running' });
    await deps.recordStore.update(failed.invocationId, { status: 'failed', error: 'boom' });
    const { source } = await realPresenceSource(deps);
    assert.deepEqual(
      await source.getPresence(['thread_terminal_failure'], 'alice'),
      new Map([['thread_terminal_failure', { status: 'error' }]]),
    );

    await deps.recordStore.update(failed.invocationId, { status: 'canceled' });
    assert.deepEqual(
      await source.getPresence(['thread_terminal_failure'], 'alice'),
      new Map(),
      'canceled is an authoritative clear, not success/error',
    );
  });

  it('retrying the latest failed invocation clears its terminal witness instead of reviving older history', async () => {
    const deps = await realDeps();
    const oldSuccess = await deps.recordStore.create({
      threadId: 'thread_retry',
      userId: 'alice',
      targetCats: ['opus5'],
      intent: 'execute',
      idempotencyKey: 'old-success',
      actionLeaseCarrier: { kind: 'none' },
    });
    await deps.recordStore.update(oldSuccess.invocationId, { status: 'running' });
    await deps.recordStore.update(oldSuccess.invocationId, { status: 'succeeded', successfulCatIds: ['opus5'] });

    const retry = await deps.recordStore.create({
      threadId: 'thread_retry',
      userId: 'alice',
      targetCats: ['codex-sol'],
      intent: 'execute',
      idempotencyKey: 'retry',
      actionLeaseCarrier: { kind: 'none' },
    });
    await deps.recordStore.update(retry.invocationId, { status: 'running' });
    await deps.recordStore.update(retry.invocationId, { status: 'failed', error: 'transient' });
    assert.equal(
      (await deps.recordStore.listLatestTerminalByThreadIds(['thread_retry'], 'alice')).get('thread_retry')?.id,
      retry.invocationId,
    );

    await deps.recordStore.update(retry.invocationId, { status: 'running', expectedStatus: 'failed' });
    assert.equal(
      (await deps.recordStore.listLatestTerminalByThreadIds(['thread_retry'], 'alice')).size,
      0,
      'a retry is a new attempt; the older success must not leak back into presentation',
    );
  });

  it('R3 P1-1 end-to-end: a running managed command reads as working, not done', async () => {
    const thread = threadStore.create('alice', 'Managed command running', '/p');
    // 历史上回过话：保留这个反例，确保 working 不会被旧消息覆盖。
    threadStore.updateParticipantActivity(thread.id, 'opus5', true);

    const deps = await realDeps();
    deps.tasks = [runningManagedCommandTask({ id: 't1', threadId: thread.id, catId: 'opus5', userId: 'alice' })];
    const { source } = await realPresenceSource(deps);

    const rows = await sidebarRows({ presenceSource: source });
    assert.equal(
      rows.get(thread.id).presence.status,
      'working',
      'a thread whose managed command is still running must not read as done',
    );
  });

  it('R3 P1-2 end-to-end: a standalone running child reads as working, not done', async () => {
    const thread = threadStore.create('alice', 'Child running', '/p');
    threadStore.updateParticipantActivity(thread.id, 'sonnet', true);

    const deps = await realDeps();
    await deps.turnExecutionStore.createRunning({
      invocationId: 'child_e2e',
      parentInvocationId: 'parent_absent',
      threadId: thread.id,
      userId: 'alice',
      catId: 'sonnet',
      executionKind: 'ordinary',
      startedAt: 2000,
    });
    const { source } = await realPresenceSource(deps);

    const rows = await sidebarRows({ presenceSource: source });
    assert.equal(rows.get(thread.id).presence.status, 'working');
  });

  it('R3 P1-3: incomplete candidate discovery must NOT surface as done/error', async () => {
    const thread = threadStore.create('alice', 'Actually running', '/p');
    threadStore.updateParticipantActivity(thread.id, 'opus5', true);

    const deps = await realDeps();
    // 唯一 active 真相源抛错：union 变空，但 discovery 必须报 incomplete
    deps.recordStore.listRunningThreadIds = () => {
      throw new Error('record index unavailable');
    };
    const { source } = await realPresenceSource(deps);

    const rows = await sidebarRows({ presenceSource: source });
    const status = rows.get(thread.id).presence.status;
    assert.notEqual(status, 'done', 'incomplete knowledge must never be published as a terminal state');
    assert.notEqual(status, 'error');
    assert.equal(status, 'idle');
  });

  it('a lifecycle projection failure keeps HTTP 200 and every row idle', async () => {
    const runningThread = threadStore.create('alice', 'Still running', '/p');
    const historyThread = threadStore.create('alice', 'Has history', '/p');
    threadStore.updateParticipantActivity(historyThread.id, 'opus5', true);

    const rows = await sidebarRows({
      presenceSource: {
        getPresence: async () => {
          throw new Error('lifecycle projection unavailable');
        },
      },
      unreadByThread: new Map([
        [runningThread.id, 1],
        [historyThread.id, 1],
      ]),
    });

    assert.equal(rows.get(runningThread.id).presence.status, 'idle');
    assert.equal(rows.get(historyThread.id).presence.status, 'idle');
  });
});
