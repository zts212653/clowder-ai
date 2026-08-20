/**
 * F297 Phase B — Sidebar C10 终态回落语义（participant activity → done/error/idle）。
 *
 * 核心铁律：**active 缺席不得推断为 done**。知识不完整时一律封 idle。
 */

import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import Fastify from 'fastify';
import { load, realDeps, realPresenceSource, runningManagedCommandTask } from './helpers/f297-presence-fixtures.js';

describe('F297 terminal presence semantics (C10 fallback)', () => {
  let threadStore;
  let app;

  beforeEach(async () => {
    const { ThreadStore } = await load('domains/cats/services/stores/ports/ThreadStore.js');
    threadStore = new ThreadStore();
  });

  async function sidebarRows({ activePresence = new Map(), presenceSource } = {}) {
    const { threadsRoutes } = await load('routes/threads.js');
    if (app) await app.close();
    app = Fastify();
    await app.register(threadsRoutes, {
      threadStore,
      presenceSource: presenceSource ?? { getActivePresence: async () => activePresence },
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

  it('P1-2: a healthy latest response reads as done', async () => {
    const thread = threadStore.create('alice', 'Finished', '/p');
    threadStore.updateParticipantActivity(thread.id, 'opus5', true);

    const rows = await sidebarRows();
    assert.equal(rows.get(thread.id).presence.status, 'done');
    assert.deepEqual(rows.get(thread.id).presence.cats, ['opus5']);
  });

  it('P1-2: an unhealthy latest response reads as error', async () => {
    const thread = threadStore.create('alice', 'Broken', '/p');
    threadStore.updateParticipantActivity(thread.id, 'opus5', false);

    const rows = await sidebarRows();
    assert.equal(rows.get(thread.id).presence.status, 'error');
  });

  it('P1-2: the latest response wins — an older error is not sticky', async () => {
    const thread = threadStore.create('alice', 'Recovered', '/p');
    threadStore.updateParticipantActivity(thread.id, 'sonnet', false);
    await new Promise((resolve) => setTimeout(resolve, 2));
    threadStore.updateParticipantActivity(thread.id, 'opus5', true);

    const rows = await sidebarRows();
    const presence = rows.get(thread.id).presence;
    assert.equal(presence.status, 'done', 'a newer healthy response must clear an older error');
    assert.deepEqual(presence.cats, ['opus5']);
  });

  it('P1-2: no response at all is idle, never done', async () => {
    const thread = threadStore.create('alice', 'Untouched', '/p');
    const rows = await sidebarRows();
    assert.equal(rows.get(thread.id).presence.status, 'idle');
  });

  it('P1-2: active execution overrides terminal history', async () => {
    const thread = threadStore.create('alice', 'Running again', '/p');
    threadStore.updateParticipantActivity(thread.id, 'opus5', false);

    const rows = await sidebarRows({
      activePresence: new Map([[thread.id, { status: 'working', cats: ['opus5'] }]]),
    });
    assert.equal(rows.get(thread.id).presence.status, 'working');
  });

  it('R3 P1-1 end-to-end: a running managed command reads as working, not done', async () => {
    const thread = threadStore.create('alice', 'Managed command running', '/p');
    // 历史上回过话 → 终态回落会算成 done。这正是 false terminal 的温床。
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

  it('R11 P1-2: a terminal-fallback store failure keeps HTTP 200, active rows working, rest idle', async () => {
    // 锁住 store→composition 的失败链语义（cloud R11 P1 的下游）：
    // - getParticipantsWithActivityBatch 抛错时整个请求**不得** 500；
    // - 有 active 的行仍然 working（它不依赖终态回落）；
    // - 其余行封 idle，绝不是 done/error。
    const runningThread = threadStore.create('alice', 'Still running', '/p');
    const historyThread = threadStore.create('alice', 'Has history', '/p');
    // 历史上回过话 → 正常路径会算成 done，正是 false terminal 的温床
    threadStore.updateParticipantActivity(historyThread.id, 'opus5', true);

    threadStore.getParticipantsWithActivityBatch = async () => {
      throw new Error('activity pipeline unavailable');
    };

    const rows = await sidebarRows({
      activePresence: new Map([[runningThread.id, { status: 'working', cats: ['opus5'] }]]),
    });

    assert.equal(rows.get(runningThread.id).presence.status, 'working', 'active rows survive a fallback failure');
    const degraded = rows.get(historyThread.id).presence.status;
    assert.equal(degraded, 'idle', 'unknown terminal knowledge must degrade to idle');
    assert.notEqual(degraded, 'done');
    assert.notEqual(degraded, 'error');
  });
});
