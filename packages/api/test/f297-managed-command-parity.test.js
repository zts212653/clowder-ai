/**
 * F297 — managed command 投影 与 取消路径 的判别 parity。
 *
 * 为什么需要一张共用表：投影侧（`listManagedCommandExecutions` → active-execution 列表，
 * 无条件标 `cancelable`）与取消侧（DELETE → `isCancelableHoldBallTask`）是两条独立代码路径。
 * 一旦判别漂移，后果不是"少显示"，而是**用户点了取消却取消不掉**。
 *
 * 这个裂缝在 PR #3748 里出现过两次，两次都是投影比取消路径宽：
 *   R4 P2-1（retired 分支）：不校验任务身份、不要求 `holdLifecycle.createdBy`
 *   R5 P1-1（active 分支）：同一裂缝的另一半 —— 当时只补了 retired，因为把"与旧 predicate
 *     等价"当成了目标。参照系错了：旧代码的 active 分支本来就不校验身份。判据应该是
 *     **取消路径认不认**，不是有没有忠实复刻旧行为。
 *
 * 因此本表 **active 与 retired 共用**，并锁一条结构性不变量：
 *   投影出来的执行，取消路径必须认。
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { load } from './helpers/f297-presence-fixtures.js';

/** 真实 hold-ball wake carrier 形状；overrides 用来逐维度破坏它。 */
function holdBallTask({ enabled, lifecycle = {}, command = {}, ...overrides }) {
  return {
    id: 'hold-ball-1',
    templateId: 'reminder',
    enabled,
    deliveryThreadId: 'thread_x',
    createdBy: 'hold-ball:opus5',
    params: {
      triggerUserId: 'alice',
      holdLifecycle: {
        mode: 'wake_when',
        status: enabled ? 'active' : 'cancelled_by_user',
        createdBy: 'hold-ball:opus5',
        managedCommand: { state: 'command_running', command: 'pnpm gate', startedAt: 1, ...command },
        ...lifecycle,
      },
    },
    ...overrides,
  };
}

const activeTask = (patch = {}) => holdBallTask({ enabled: true, ...patch });
const retiredTask = (patch = {}) => holdBallTask({ enabled: false, ...patch });

describe('F297 managed command projection ↔ cancel path parity', () => {
  for (const [branch, make] of [
    ['active', activeTask],
    ['retired', retiredTask],
  ]) {
    it(`${branch} branch: projection agrees with the cancel path on every identity dimension`, async () => {
      const { listManagedCommandExecutions } = await load(
        'domains/cats/services/agents/invocation/active-execution-service.js',
      );
      const { isCancelableHoldBallTask } = await load('routes/hold-ball-cancel.js');

      const cases = [
        ['canonical hold-ball task', make(), true],
        ['non hold-ball task id', make({ id: 'dyn-not-hold' }), false],
        ['non reminder templateId', make({ templateId: 'other' }), false],
        ['non hold-ball createdBy', make({ createdBy: 'scheduler' }), false],
        ['lifecycle without createdBy', make({ lifecycle: { createdBy: undefined } }), false],
        ['command already consumed', make({ command: { state: 'consumed' } }), false],
      ];

      for (const [label, task, expectedProjected] of cases) {
        const projected = listManagedCommandExecutions([task]).length === 1;
        assert.equal(projected, expectedProjected, `${branch}/projection: ${label}`);
        if (projected) {
          // 结构性不变量：投影出来的执行，取消路径必须认它。
          assert.equal(
            isCancelableHoldBallTask(task),
            true,
            `${branch}: projected an execution the cancel path refuses — ${label}`,
          );
        }
      }
    });
  }

  it('R5 P1-1: a malformed active task is never projected as a cancelable execution', async () => {
    const { listManagedCommandExecutions } = await load(
      'domains/cats/services/agents/invocation/active-execution-service.js',
    );
    const { isPendingHoldBallTask, isCancelableHoldBallTask } = await load('routes/hold-ball-cancel.js');

    // reviewer 探针原样：投影=1 但 isPending=false / isCancelable=false。
    const malformed = activeTask({ id: 'dyn-not-hold', templateId: 'other' });
    assert.equal(isPendingHoldBallTask(malformed), false, 'precondition: the cancel path refuses this task');
    assert.equal(isCancelableHoldBallTask(malformed), false);
    assert.equal(
      listManagedCommandExecutions([malformed]).length,
      0,
      'the projection must not claim an execution the cancel path refuses',
    );
  });

  it('a disabled task whose lifecycle still claims active is neither projected nor cancelable', async () => {
    const { listManagedCommandExecutions } = await load(
      'domains/cats/services/agents/invocation/active-execution-service.js',
    );
    const { isPendingHoldBallTask, isCancelableHoldBallTask } = await load('routes/hold-ball-cancel.js');

    // 既不是合法 active（carrier 已 disabled），也不是合法 retired tombstone
    // （status 不是 cancelled_by_user）。`enabled` 必须是一个**独立**的判别维度：
    // 少了它，retired 任务会误走 pending 分支，而两条路径的最终布尔恰好相同、
    // 缺口会被掩盖（R6 mutation Q3 就是这样存活的）。
    const task = holdBallTask({ enabled: false, lifecycle: { status: 'active' } });

    assert.equal(isPendingHoldBallTask(task), false, 'a disabled carrier is not pending');
    assert.equal(isCancelableHoldBallTask(task), false);
    assert.equal(
      listManagedCommandExecutions([task]).length,
      0,
      'the projection must not claim an execution the cancel path refuses',
    );
  });

  it('cross-user isolation moved to the consumer layer (#3763): enumerator is principal-blind, service filter still holds', async () => {
    // PR #3763 语义：trigger ownership 决定"能不能停"，不决定"能不能看见"——route 列表
    // 要显示 foreign 占用（not_cancelable + 合成 occupied: id，f295 测试锁定）。因此
    // **枚举器 principal-blind**，携带 userId 让消费方判定；Sidebar 定性/候选发现的
    // per-user 隔离由 service 消费面 filter 保证（是否把 foreign 占用算进 working 是
    // 独立设计决策，暂保持 per-user）。本测试锁两层新契约。
    const { listManagedCommandExecutions, createActiveExecutionService } = await load(
      'domains/cats/services/agents/invocation/active-execution-service.js',
    );
    const mine = activeTask();

    // 层 1：枚举器 principal-blind——谁调都返回，userId 如实携带（消费方判定的输入）。
    const all = listManagedCommandExecutions([mine]);
    assert.equal(all.length, 1);
    assert.equal(all[0].userId, 'alice');

    // 层 2：service 消费面（Sidebar 定性/候选发现走这里）per-user 隔离仍然成立。
    const service = createActiveExecutionService({
      invocationTracker: { getActiveSlots: () => [], getUserId: () => null },
      dynamicTaskStore: { getAll: () => [mine] },
      log: { info: () => {}, warn: () => {} },
    });
    assert.equal(service.listManagedCommandExecutions('alice').length, 1);
    assert.equal(
      service.listManagedCommandExecutions('mallory').length,
      0,
      'cross-user managed commands must not leak into another user’s sidebar qualification',
    );
  });
});
