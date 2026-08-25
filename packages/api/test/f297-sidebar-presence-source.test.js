/**
 * F297 Phase B — 服务端 working projection（真实 service，定性通道零 stub）。
 *
 * 覆盖：三张执行面各自的正向定性、O(A) 候选成本、以及"知识不完整不得产出终态"的
 * fail-closed 铁律。managed command 的判别 parity 见 f297-managed-command-parity.test.js；
 * InvocationRecord terminal witness 语义见 f297-terminal-presence.test.js。
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  load,
  realDeps,
  realPresenceSource,
  runningManagedCommandTask,
  startRunningRecordWithDraft,
} from './helpers/f297-presence-fixtures.js';

describe('F297 production presence source (real service, no classifier stub)', () => {
  it('R1: a real tracker slot + draft surfaces as working through the real composition', async () => {
    const deps = await realDeps();
    // NB: tracker slot **alone** is not canonical liveness — F194 treats the tracker as the
    // control plane, not lifecycle truth. 前两轮测试之所以看起来能过，是因为它把 classifier
    // stub 成"读 tracker slot"，等于用假 classifier 复述了自己的假设。真实路径要 tracker+draft。
    deps.invocationTracker.start('thread_live', 'opus5', 'alice');
    await deps.draftStore.upsert({
      userId: 'alice',
      threadId: 'thread_live',
      invocationId: 'inv_live',
      catId: 'opus5',
      content: 'thinking…',
      updatedAt: Date.now(),
    });
    const { source } = await realPresenceSource(deps);

    const presence = await source.getPresence(['thread_live', 'thread_quiet'], 'alice');
    assert.equal(presence.get('thread_live')?.status, 'working');
    assert.deepEqual(presence.get('thread_live')?.cats, ['opus5']);
    assert.equal(presence.has('thread_quiet'), false, 'a thread without any execution must not be reported active');
  });

  it('R2 P1-1: tracker empty but a running record + fresh draft exists → working', async () => {
    const deps = await realDeps();
    await startRunningRecordWithDraft(deps, { threadId: 'thread_record', userId: 'alice', catId: 'opus5' });
    const { source } = await realPresenceSource(deps);

    const presence = await source.getPresence(['thread_record'], 'alice');
    assert.equal(
      presence.get('thread_record')?.status,
      'working',
      'record+draft canonical active must never fall through to terminal activity',
    );
    assert.deepEqual(presence.get('thread_record')?.cats, ['opus5']);
  });

  it('R3 P1-1: a running managed command is qualified by the REAL pipeline, not just nominated', async () => {
    const deps = await realDeps();
    deps.tasks = [
      runningManagedCommandTask({ id: 't1', threadId: 'thread_managed', catId: 'opus5', userId: 'alice' }),
      runningManagedCommandTask({ id: 't2', threadId: 'thread_other_user', catId: 'opus5', userId: 'bob' }),
      runningManagedCommandTask({
        id: 't3',
        threadId: 'thread_finished',
        catId: 'opus5',
        userId: 'alice',
        state: 'consumed',
      }),
    ];
    const { service, source } = await realPresenceSource(deps);

    // 前提复现：这条 thread 没有任何 live invocation —— 旧结构正是在这里 presence=null。
    const live = await service.resolveActiveInvocations('thread_managed', 'alice');
    assert.deepEqual(live, [], 'precondition: the live-invocation classifier knows nothing about managed commands');

    const presence = await source.getPresence(['thread_managed', 'thread_other_user', 'thread_finished'], 'alice');
    assert.equal(presence.get('thread_managed')?.status, 'working', 'R3 P1-1: managed command must qualify as working');
    assert.deepEqual(presence.get('thread_managed')?.cats, ['opus5'], 'the owning cat comes from managed owner truth');
    assert.equal(presence.get('thread_managed')?.activeSince, 1000, 'managed startedAt is canonical elapsed truth');
    assert.equal(presence.has('thread_other_user'), false, 'another user’s command must not leak');
    assert.equal(presence.has('thread_finished'), false, 'a non-running command is not working');
  });

  it('R3 P1-2: a standalone running child (no running parent record) is qualified as working', async () => {
    const deps = await realDeps();
    // parent record 不存在 —— F194 的 buildRunningChildExecutionLink 只从 running parent 反查，
    // 所以这个 canonical child 对 live-invocation classifier 完全不可见。
    await deps.turnExecutionStore.createRunning({
      invocationId: 'child_1',
      parentInvocationId: 'parent_absent',
      threadId: 'thread_child',
      userId: 'alice',
      catId: 'sonnet',
      executionKind: 'ordinary',
      startedAt: 2000,
    });
    const { service, source } = await realPresenceSource(deps);

    const live = await service.resolveActiveInvocations('thread_child', 'alice');
    assert.deepEqual(live, [], 'precondition: classifier cannot reach a child whose parent is not a running record');

    const presence = await source.getPresence(['thread_child'], 'alice');
    assert.equal(presence.get('thread_child')?.status, 'working', 'R3 P1-2: standalone running child must be working');
    assert.deepEqual(presence.get('thread_child')?.cats, ['sonnet']);
    assert.equal(presence.get('thread_child')?.activeSince, 2000, 'child startedAt is canonical elapsed truth');

    const otherUser = await source.getPresence(['thread_child'], 'mallory');
    assert.equal(otherUser.has('thread_child'), false, 'child ownership is user-scoped');
  });

  it('R3 P1-2: a child that reached terminal stops being working', async () => {
    const deps = await realDeps();
    await deps.turnExecutionStore.createRunning({
      invocationId: 'child_done',
      parentInvocationId: 'parent_absent',
      threadId: 'thread_child',
      userId: 'alice',
      catId: 'sonnet',
      executionKind: 'ordinary',
      startedAt: 2000,
    });
    await deps.turnExecutionStore.transitionTerminal('child_done', { status: 'succeeded', endedAt: 3000 });
    const { source } = await realPresenceSource(deps);

    const presence = await source.getPresence(['thread_child'], 'alice');
    assert.equal(presence.has('thread_child'), false, 'a terminal child must not keep the row pinned to working');
  });

  it('R3: the three execution faces union rather than shadow each other', async () => {
    const deps = await realDeps();
    deps.invocationTracker.start('thread_all', 'opus5', 'alice');
    await deps.draftStore.upsert({
      userId: 'alice',
      threadId: 'thread_all',
      invocationId: 'inv_all',
      catId: 'opus5',
      content: 'thinking…',
      updatedAt: Date.now(),
    });
    deps.tasks = [runningManagedCommandTask({ id: 't1', threadId: 'thread_all', catId: 'gpt52', userId: 'alice' })];
    await deps.turnExecutionStore.createRunning({
      invocationId: 'child_x',
      parentInvocationId: 'parent_absent',
      threadId: 'thread_all',
      userId: 'alice',
      catId: 'sonnet',
      executionKind: 'ordinary',
      startedAt: 2000,
    });
    const { source } = await realPresenceSource(deps);

    const presence = await source.getPresence(['thread_all'], 'alice');
    assert.equal(presence.get('thread_all')?.status, 'working');
    assert.deepEqual(
      [...presence.get('thread_all').cats].sort(),
      ['gpt52', 'opus5', 'sonnet'],
      'every face contributes its own cats; none is dropped',
    );
    assert.equal(
      presence.get('thread_all')?.activeSince,
      1000,
      'multi-face working elapsed begins at the earliest canonical execution start',
    );
  });

  it('OQ-1: candidate discovery keeps the work O(A), not O(T)', async () => {
    const deps = await realDeps();
    const { service, source } = await realPresenceSource(deps);
    let qualified = 0;
    const counting = {
      buildSnapshot: (userId) => service.buildSnapshot(userId),
      resolveWorkingPresence: (threadId, userId, snapshot) => {
        qualified += 1;
        return service.resolveWorkingPresence(threadId, userId, snapshot);
      },
      listLatestTerminalExecutions: async () => new Map(),
    };
    const { createSidebarPresenceSource } = await load(
      'domains/cats/services/agents/invocation/sidebar-presence-source.js',
    );
    const counted = createSidebarPresenceSource(counting);

    const presence = await counted.getPresence(['a', 'b', 'c'], 'alice');
    assert.equal(presence.size, 0);
    assert.equal(qualified, 0, 'nothing is running → zero qualification round-trips');
    assert.ok(source, 'real source builds');
  });

  it('R4 P1-1: owner-truth global enumerations stay constant as A grows', async () => {
    // managed / child 两张脸是 user-scoped 全局枚举（Redis 侧 = SMEMBERS + pipeline HGETALL），
    // 成本与 candidate 数无关。逐 candidate 重读会让 A 个候选形成 1+A 次全局枚举（最坏 O(A²)）。
    const deps = await realDeps();
    const threads = ['t1', 't2', 't3', 't4'];
    for (const [index, threadId] of threads.entries()) {
      await deps.turnExecutionStore.createRunning({
        invocationId: `child_${index}`,
        parentInvocationId: 'parent_absent',
        threadId,
        userId: 'alice',
        catId: 'sonnet',
        executionKind: 'ordinary',
        startedAt: 100 + index,
      });
    }
    deps.tasks = threads.map((threadId, index) =>
      runningManagedCommandTask({ id: `${index}`, threadId, catId: 'gpt52', userId: 'alice' }),
    );

    let childEnumerations = 0;
    let taskEnumerations = 0;
    const realStore = deps.turnExecutionStore;
    deps.turnExecutionStore = {
      listByParent: (...args) => realStore.listByParent(...args),
      listRunningByUser: (...args) => {
        childEnumerations += 1;
        return realStore.listRunningByUser(...args);
      },
    };
    const realTasks = deps.tasks;
    const { source } = await realPresenceSource(deps, {
      serviceDeps: {
        dynamicTaskStore: {
          getAll: () => {
            taskEnumerations += 1;
            return realTasks;
          },
        },
      },
    });

    const presence = await source.getPresence(threads, 'alice');
    for (const threadId of threads) {
      assert.equal(presence.get(threadId)?.status, 'working', `${threadId} must still qualify`);
      assert.deepEqual([...presence.get(threadId).cats].sort(), ['gpt52', 'sonnet']);
    }
    assert.equal(childEnumerations, 1, `child ledger must be enumerated once per request, got ${childEnumerations}`);
    assert.equal(taskEnumerations, 1, `task store must be enumerated once per request, got ${taskEnumerations}`);
  });

  it('R3 P1-3: a failing candidate source marks discovery incomplete', async () => {
    const deps = await realDeps();
    deps.recordStore.listRunningThreadIds = () => {
      throw new Error('record index unavailable');
    };
    const { service } = await realPresenceSource(deps);

    const partial = await service.buildSnapshot('alice');
    assert.equal(partial.complete, false, 'a dropped source must be reported, not silently swallowed');

    const healthy = await realDeps().then((d) => realPresenceSource(d));
    assert.equal((await healthy.service.buildSnapshot('alice')).complete, true);
  });

  it('R3 P1-3: a qualification failure seals the row as idle, never terminal', async () => {
    const deps = await realDeps();
    deps.invocationTracker.start('thread_boom', 'opus5', 'alice');
    const { service } = await realPresenceSource(deps);
    const { createSidebarPresenceSource } = await load(
      'domains/cats/services/agents/invocation/sidebar-presence-source.js',
    );
    const source = createSidebarPresenceSource({
      buildSnapshot: (userId) => service.buildSnapshot(userId),
      resolveWorkingPresence: async () => {
        throw new Error('qualification exploded');
      },
      listLatestTerminalExecutions: async () => new Map(),
    });

    const presence = await source.getPresence(['thread_boom'], 'alice');
    // 这一行被提名过 —— 它恰恰是最可能真在跑的行。放它去走终态回落就是 false terminal。
    assert.equal(
      presence.get('thread_boom')?.status,
      'idle',
      'a nominated candidate whose qualification failed must be sealed idle, not handed to terminal fallback',
    );
    assert.notEqual(presence.get('thread_boom')?.status, 'working', 'and never fabricated as working');
  });

  it('R3 P1-3: a partially-failed qualification never publishes a terminal state', async () => {
    const deps = await realDeps();
    deps.tasks = [runningManagedCommandTask({ id: 't1', threadId: 'thread_partial', catId: 'opus5', userId: 'alice' })];
    // 三张脸里的 child 面坏掉：working 仍能由 managed 面给出，但完整性必须被记账。
    deps.turnExecutionStore.listRunningByUser = () => {
      throw new Error('child ledger unavailable');
    };
    const { service } = await realPresenceSource(deps);

    const working = await service.resolveWorkingPresence('thread_partial', 'alice');
    assert.deepEqual(working.catIds, ['opus5'], 'surviving faces still qualify');
    assert.equal(working.complete, false, 'a dropped face must be reported so callers can fail closed');
  });
  it('R3 P1-3: a liveness read failure during qualification must not read as done', async () => {
    const deps = await realDeps();
    // 候选索引可读（thread 被提名），但按 thread 的 canonical 读取在定性时失败。
    // GET /queue 的 fail-open 包装会把它降级成 tracker-only 并**静默**报"没有 active"，
    // Sidebar 若沿用那条路径就会把正在跑的 thread 显示成 done。
    deps.recordStore.listRunningThreadIds = () => ['thread_x'];
    deps.recordStore.listRunningByThread = () => {
      throw new Error('record read failed during qualification');
    };
    const { service, source } = await realPresenceSource(deps);

    const discovery = await service.buildSnapshot('alice');
    assert.deepEqual([...discovery.threadIds], ['thread_x'], 'the thread is still nominated');

    const working = await service.resolveWorkingPresence('thread_x', 'alice');
    assert.equal(working.complete, false, 'a swallowed liveness failure must still be accounted as incomplete');

    const presence = await source.getPresence(['thread_x'], 'alice');
    assert.equal(presence.get('thread_x')?.status, 'idle', 'fail closed: idle, never a terminal state');
  });

  it('GET /queue keeps its fail-open contract despite the strict qualification path', async () => {
    const { resolveActiveInvocations } = await load(
      'domains/cats/services/agents/invocation/active-execution-service.js',
    );
    const deps = await realDeps();
    deps.invocationTracker.start('thread_x', 'opus5', 'alice');
    deps.recordStore.listRunningByThread = () => {
      throw new Error('record read failed');
    };
    let warned = 0;
    const projections = await resolveActiveInvocations(
      'thread_x',
      'alice',
      deps.invocationTracker,
      deps.recordStore,
      deps.draftStore,
      deps.turnExecutionStore,
      {
        info() {},
        warn() {
          warned += 1;
        },
      },
    );
    assert.equal(warned, 1, 'the fallback stays observable as a metric');
    assert.deepEqual(
      projections.map((p) => p.catId),
      ['opus5'],
      'the queue endpoint still degrades to tracker-only instead of 500ing',
    );
  });
});
