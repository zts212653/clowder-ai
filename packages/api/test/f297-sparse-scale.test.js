/**
 * F297 AC-B2 + AC-D3 —— 规模不变量。
 *
 * AC-B2 白纸黑字要求 1760/300/20 fixture 证明「liveness 调用随 A 而非 T 增长」。
 * 结构性不变量在 4 个 thread 上成立 ≠ 规模断言成立，所以这里把规模补到位。
 *
 * 但它**不是压测**：真实延迟属于运行健康（另记 metrics/traces），不拿任意毫秒阈值冒充
 * 设计证明。这里锁的是**调用计数**——一个确定契约。
 *
 * 两条 AC 其实是同一条不变量的两个 consumer：
 *
 *   任何「谁在跑」的查询，其 per-thread 定性调用次数 == |候选 ∩ 查询集|，与查询集大小 T 无关。
 *
 *   - Sidebar（AC-B2）：`getPresence(1760 rows)`
 *   - project scan（AC-D3）：`GET /executions/active`，F295 每 4 秒一次
 *
 * AC-D3 要求「不留两份读法」。旧实现里 project scan 仍是 `threads.map(resolveLiveExecutions)`，
 * 即每 4 秒 O(T) 次定性——与 Sidebar 的稀疏快照并存，正是 D3 点名的重复读取。
 */

import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';
import Fastify from 'fastify';

const { InvocationQueue } = await import('../dist/domains/cats/services/agents/invocation/InvocationQueue.js');
const { queueRoutes } = await import('../dist/routes/queue.js');
const { InvocationTracker } = await import('../dist/domains/cats/services/agents/invocation/InvocationTracker.js');
const { InvocationRecordStore } = await import('../dist/domains/cats/services/stores/ports/InvocationRecordStore.js');
const { DraftStore } = await import('../dist/domains/cats/services/stores/ports/DraftStore.js');
const { createActiveExecutionService } = await import(
  '../dist/domains/cats/services/agents/invocation/active-execution-service.js'
);
const { createSidebarPresenceSource } = await import(
  '../dist/domains/cats/services/agents/invocation/sidebar-presence-source.js'
);

const USER_ID = 'user-scale';
const PROJECT = '/scale';
const TOTAL_THREADS = 1760;
const PINNED = 300;
const ACTIVE = 20;

/** 真实 tracker + 真实 store —— snapshot 是真的，只有调用计数被观测。 */
async function buildScaleFixture() {
  const threads = new Map();
  for (let i = 0; i < TOTAL_THREADS; i += 1) {
    const id = `thread-${i}`;
    threads.set(id, {
      id,
      title: `t${i}`,
      projectPath: PROJECT,
      createdBy: USER_ID,
      pinned: i < PINNED,
    });
  }

  const invocationTracker = new InvocationTracker();
  const recordStore = new InvocationRecordStore();
  const draftStore = new DraftStore();
  const dynamicTaskStore = { getAll: mock.fn(() => []) };

  // 20 个真正在跑的 thread：tracker slot + fresh draft = F194 的 tracker+draft canonical active
  const activeThreadIds = [];
  for (let i = 0; i < ACTIVE; i += 1) {
    const id = `thread-${i * 7}`; // 散布在 1760 里，不集中在头部
    activeThreadIds.push(id);
    invocationTracker.start(id, 'opus5', USER_ID);
    await draftStore.upsert({
      userId: USER_ID,
      threadId: id,
      invocationId: `inv-${id}`,
      catId: 'opus5',
      content: 'working…',
      updatedAt: Date.now(),
    });
  }

  const service = createActiveExecutionService({
    invocationTracker,
    recordStore,
    draftStore,
    dynamicTaskStore,
    log: { info() {}, warn() {} },
  });

  return { threads, invocationTracker, recordStore, draftStore, dynamicTaskStore, service, activeThreadIds };
}

describe(`F297 AC-B2/AC-D3 — ${TOTAL_THREADS}/${PINNED}/${ACTIVE} scale invariant`, () => {
  it('Sidebar: per-thread qualification runs A times, not T', async () => {
    const { service, activeThreadIds, threads, dynamicTaskStore } = await buildScaleFixture();

    let qualifyCalls = 0;
    let snapshotBuilds = 0;
    const source = createSidebarPresenceSource({
      buildSnapshot: (userId) => {
        snapshotBuilds += 1;
        return service.buildSnapshot(userId);
      },
      resolveWorkingPresence: (threadId, userId, snapshot) => {
        qualifyCalls += 1;
        return service.resolveWorkingPresence(threadId, userId, snapshot);
      },
      listLatestTerminalExecutions: async () => new Map(),
    });

    const presence = await source.getPresence([...threads.keys()], USER_ID);

    assert.equal(qualifyCalls, ACTIVE, `qualification must run A(${ACTIVE}) times, not T(${TOTAL_THREADS})`);
    assert.equal(snapshotBuilds, 1, 'owner-truth must be materialised once per request (R4 P1-1)');
    assert.equal(dynamicTaskStore.getAll.mock.callCount(), 1, 'managed owner truth must be read once per request');
    assert.equal(presence.size, ACTIVE, 'exactly the active rows carry presence');
    for (const id of activeThreadIds) {
      assert.equal(presence.get(id)?.status, 'working', `${id} must read as working`);
    }
  });

  it('project scan: per-thread qualification runs A times, not T (AC-D3 — no second read pattern)', async () => {
    const { threads, invocationTracker, service, activeThreadIds, recordStore, draftStore, dynamicTaskStore } =
      await buildScaleFixture();

    // 计数点选在 liveness 真相源上：resolveActiveInvocations 每定性一个 thread 就会读一次 draft。
    // 这样计的是**生产路径**的实际定性次数，而不是我自己包的一层壳。
    let liveCalls = 0;
    const countingDraftStore = {
      ...draftStore,
      getByThread: (userId, threadId) => {
        liveCalls += 1;
        return draftStore.getByThread(userId, threadId);
      },
    };
    const app = Fastify();
    await app.register(queueRoutes, {
      threadStore: {
        get: mock.fn(async (id) => threads.get(id) ?? null),
        listByProject: mock.fn(async (userId, projectPath) =>
          userId === USER_ID ? [...threads.values()].filter((t) => t.projectPath === projectPath) : [],
        ),
      },
      invocationQueue: new InvocationQueue(),
      invocationTracker,
      activeExecutionService: {
        buildLiveCandidateSnapshot: (userId) => service.buildLiveCandidateSnapshot(userId),
      },
      invocationRecordStore: recordStore,
      draftStore: countingDraftStore,
      dynamicTaskStore: { ...dynamicTaskStore, getById: mock.fn(() => null) },
      queueProcessor: {
        canReleaseSlotForUser: mock.fn(() => true),
        processNext: mock.fn(async () => ({ started: false })),
        isPaused: mock.fn(() => false),
        getPauseReason: mock.fn(() => undefined),
        clearPause: mock.fn(),
        releaseSlot: mock.fn(),
        releaseThread: mock.fn(),
      },
      socketManager: {
        broadcastAgentMessage: mock.fn(),
        broadcastToRoom: mock.fn(),
        emitToUser: mock.fn(),
      },
      agentSessionMutex: {
        forceReleaseByScope: mock.fn(() => ({ releasedHolders: 0, rejectedWaiters: 0, catIds: [] })),
      },
      getManagedCommandWakeRecovery: () => undefined,
    });
    await app.ready();

    const res = await app.inject({
      method: 'GET',
      url: `/api/threads/thread-0/executions/active`,
      headers: { 'x-cat-cafe-user': USER_ID },
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    await app.close();

    // 行为不变：20 个真实执行一个都不能少
    assert.equal(
      body.executions.length,
      ACTIVE,
      'every genuinely running execution must still be listed after narrowing',
    );
    assert.deepEqual(
      body.executions.map((e) => e.threadId).sort(),
      [...activeThreadIds].sort(),
      'narrowing must not drop or invent an execution',
    );
    // AC-D3：成本随 A 而非 T
    assert.equal(
      liveCalls,
      ACTIVE,
      `project scan must qualify A(${ACTIVE}) threads, not T(${TOTAL_THREADS}) — it runs every 4s`,
    );
    assert.equal(
      dynamicTaskStore.getAll.mock.callCount(),
      1,
      'project scan must not read the same managed-command table once for candidates and again for projection',
    );
  });

  it('project scan fails OPEN when the snapshot is incomplete (opposite of Sidebar, on purpose)', async () => {
    // 漏报后果不同 ⇒ 降级方向相反：
    //   Sidebar 漏报 → 显示 idle（用户无损）→ fail-closed
    //   本列表漏报 → 正在跑的执行不在可取消列表里 → 用户停不掉 → **fail-open**
    const { threads, invocationTracker, service, activeThreadIds, draftStore } = await buildScaleFixture();

    for (const [label, snapshotSource] of [
      ['complete=false', { buildLiveCandidateSnapshot: async () => ({ threadIds: [], complete: false }) }],
      [
        'snapshot read throws',
        {
          buildLiveCandidateSnapshot: async () => {
            throw new Error('candidate source unavailable');
          },
        },
      ],
      ['not wired at all', undefined],
    ]) {
      let liveCalls = 0;
      const countingDraftStore = {
        ...draftStore,
        getByThread: (userId, threadId) => {
          liveCalls += 1;
          return draftStore.getByThread(userId, threadId);
        },
      };
      const app = Fastify();
      await app.register(queueRoutes, {
        threadStore: {
          get: mock.fn(async (id) => threads.get(id) ?? null),
          listByProject: mock.fn(async (userId, projectPath) =>
            userId === USER_ID ? [...threads.values()].filter((t) => t.projectPath === projectPath) : [],
          ),
        },
        invocationQueue: new InvocationQueue(),
        invocationTracker,
        ...(snapshotSource ? { activeExecutionService: snapshotSource } : {}),
        invocationRecordStore: new InvocationRecordStore(),
        draftStore: countingDraftStore,
        dynamicTaskStore: { getAll: mock.fn(() => []), getById: mock.fn(() => null) },
        queueProcessor: {
          canReleaseSlotForUser: mock.fn(() => true),
          processNext: mock.fn(async () => ({ started: false })),
          isPaused: mock.fn(() => false),
          getPauseReason: mock.fn(() => undefined),
          clearPause: mock.fn(),
          releaseSlot: mock.fn(),
          releaseThread: mock.fn(),
        },
        socketManager: {
          broadcastAgentMessage: mock.fn(),
          broadcastToRoom: mock.fn(),
          emitToUser: mock.fn(),
        },
        agentSessionMutex: {
          forceReleaseByScope: mock.fn(() => ({ releasedHolders: 0, rejectedWaiters: 0, catIds: [] })),
        },
        getManagedCommandWakeRecovery: () => undefined,
      });
      await app.ready();
      const res = await app.inject({
        method: 'GET',
        url: '/api/threads/thread-0/executions/active',
        headers: { 'x-cat-cafe-user': USER_ID },
      });
      const body = JSON.parse(res.body);
      await app.close();

      assert.equal(res.statusCode, 200, `${label}: still 200`);
      assert.equal(
        liveCalls,
        TOTAL_THREADS,
        `${label}: incomplete knowledge must fall back to the FULL scan, never a narrowed one`,
      );
      assert.deepEqual(
        body.executions.map((e) => e.threadId).sort(),
        [...activeThreadIds].sort(),
        `${label}: every running execution must remain cancelable`,
      );
      assert.ok(service, 'fixture built');
    }
  });
});
