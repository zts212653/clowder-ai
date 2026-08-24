/**
 * F297 Phase B — Sidebar canonical projection (AC-B4 RED)
 *
 * 契约：服务端必须在**一次请求**里回答所有 Sidebar rows 的
 *   C2 participants / C9 unread+mention / C10 presentation-ready presence。
 *
 * 今天答不了：`?view=sidebar` 只是 `Thread` 减 threadMemory 的减法投影，
 * 不含任何 presence 字段；presence 的 fold（idle/working/done/error）只存在于浏览器
 * （packages/web/src/components/ThreadCatStatus.tsx）。这两条测试锁住该缺口。
 *
 * C10 的判定优先级：active execution 优先；active 消失**不得**被推断为 done。
 * done/error 只能来自 InvocationRecord terminal transition，聊天 activity 不是 lifecycle 证据。
 */

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import Fastify from 'fastify';

const VALID_PRESENCE = new Set(['idle', 'working', 'done', 'error']);

describe('F297 Sidebar canonical projection', () => {
  let app;
  let threadStore;

  beforeEach(async () => {
    const { ThreadStore } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');
    threadStore = new ThreadStore();
  });

  afterEach(async () => {
    if (app) await app.close();
    app = undefined;
  });

  async function bootSidebar(opts = {}) {
    const { threadsRoutes } = await import('../dist/routes/threads.js');
    app = Fastify();
    await app.register(threadsRoutes, { threadStore, ...opts });
    await app.ready();
  }

  async function fetchSidebarRows(user = 'alice') {
    const res = await app.inject({
      method: 'GET',
      url: '/api/threads?view=sidebar',
      headers: { 'x-cat-cafe-user': user },
    });
    assert.equal(res.statusCode, 200);
    return JSON.parse(res.body).threads;
  }

  it('AC-B4: every sidebar row carries a presentation-ready presence (C10)', async () => {
    threadStore.create('alice', 'Idle thread', '/projects/cat-cafe');
    threadStore.create('alice', 'Another thread', '/projects/cat-cafe');
    await bootSidebar();

    const rows = await fetchSidebarRows();
    assert.ok(rows.length >= 2, 'expected the seeded rows');

    for (const row of rows) {
      assert.ok(
        Object.hasOwn(row, 'presence'),
        `row ${row.id} is missing C10 presence — Sidebar would have to re-derive it in the browser`,
      );
      assert.ok(
        VALID_PRESENCE.has(row.presence?.status),
        `row ${row.id} presence.status must be one of ${[...VALID_PRESENCE].join('|')}, got ${JSON.stringify(row.presence)}`,
      );
      // C10 明确禁止把 raw runtime 结构泄给 render 层再仲裁
      assert.equal(
        Object.hasOwn(row, 'activeInvocations'),
        false,
        'raw activeInvocations must not reach the Sidebar DTO',
      );
      assert.equal(Object.hasOwn(row, 'catInvocations'), false, 'raw catInvocations must not reach the Sidebar DTO');
    }
  });

  it('AC-B4: presence composes active execution sparsely, and absence of active is not done', async () => {
    const working = threadStore.create('alice', 'Running thread', '/projects/cat-cafe');
    const quiet = threadStore.create('alice', 'Quiet thread', '/projects/cat-cafe');

    const askedFor = [];
    const presenceSource = {
      // OQ-1 决议：只对 active candidate 稀疏对账，不对全表逐 thread 调用
      async getPresence(threadIds) {
        askedFor.push([...threadIds]);
        return new Map([[working.id, { status: 'working', cats: ['opus5'] }]]);
      },
    };

    await bootSidebar({ presenceSource });
    const rows = await fetchSidebarRows();
    const byId = new Map(rows.map((r) => [r.id, r]));

    assert.equal(byId.get(working.id).presence.status, 'working');
    assert.equal(
      byId.get(quiet.id).presence.status,
      'idle',
      'a thread with no active execution and no terminal evidence must be idle, never done',
    );
    assert.equal(askedFor.length, 1, 'presence must be resolved in one batched call, not per-thread');
  });
});
