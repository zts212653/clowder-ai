/**
 * F233 Phase A — IO 层 collector 逻辑测试（mock store）。
 *
 * 覆盖最易错的 collector 判定逻辑：zombie freshness / hold 过期分类 / mention 启发式 /
 * safeCollect 降级 / activeCount 计算。store 真实查询行为另在 duty-briefing-collect-redis.test.js。
 * 用窄 mock（满足 Pick 接口）——collector 测的是"拿到 store 数据后的判定"，不是 store 实现。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

const { collectDutyBriefingInput, collectZombies } = await import(
  '../dist/domains/cats/services/duty-briefing/collectDutyBriefingInput.js'
);

const NOW = 1_700_000_000_000;
const HOUR = 60 * 60 * 1000;
const MIN = 60 * 1000;

/** 全 mock 空 deps，测试按需 override */
function mockDeps(over = {}) {
  return {
    taskStore: { listByKind: async () => [] },
    invocationRecordStore: { scanAll: async () => [] },
    draftStore: { getByThread: async () => [] },
    dynamicTaskStore: { getAll: () => [] },
    threadStore: { list: async () => [] },
    messageStore: { getByThread: async () => [], getByThreadAfter: async () => [] },
    userId: 'default-user',
    now: NOW,
    bindingStatus: 'bound',
    ...over,
  };
}

test('collectZombies: running 无 fresh draft 且超 grace → zombie；有 fresh draft → 不报；非 running → 忽略', async () => {
  const records = [
    // 老 + 无 draft → 死球（spike opus-47 同型）
    {
      id: 'inv-dead',
      threadId: 'thr-1',
      userId: 'u',
      targetCats: ['opus-47'],
      status: 'running',
      updatedAt: NOW - 1 * HOUR,
    },
    // 老 record 但有 fresh draft（健康长任务）→ 不报
    {
      id: 'inv-alive',
      threadId: 'thr-2',
      userId: 'u',
      targetCats: ['opus'],
      status: 'running',
      updatedAt: NOW - 1 * HOUR,
    },
    // 非 running → 忽略
    {
      id: 'inv-done',
      threadId: 'thr-3',
      userId: 'u',
      targetCats: ['sonnet'],
      status: 'succeeded',
      updatedAt: NOW - 1 * HOUR,
    },
  ];
  const draftsByThread = { 'thr-2': [{ invocationId: 'inv-alive', updatedAt: NOW - 1000 }] };

  const { zombies, runningCount, runningZombieCount } = await collectZombies(
    { scanAll: async () => records },
    { getByThread: async (_u, tid) => draftsByThread[tid] ?? [] },
    'u',
    NOW,
  );

  assert.equal(runningCount, 2, 'running = inv-dead + inv-alive');
  assert.equal(runningZombieCount, 1, '仅 running stale case 计入 runningZombieCount');
  assert.equal(zombies.length, 1, '只 inv-dead 是死球');
  assert.equal(zombies[0].invocationId, 'inv-dead');
  assert.equal(zombies[0].catId, 'opus-47');
  assert.ok(zombies[0].recordUpdatedAt === NOW - 1 * HOUR);
});

test('collectZombies: scanAll 不可用（in-memory store）→ degraded=true，空结果但不伪装完整数据面', async () => {
  const { zombies, runningCount, degraded } = await collectZombies({}, { getByThread: async () => [] }, 'u', NOW);
  assert.deepEqual(zombies, []);
  assert.equal(runningCount, 0);
  assert.equal(degraded, true);
});

test('collectHolds（via 整合）: 过期 hold → deadBalls(hold-expired)，活跃 hold → activeCount，非 hold 忽略', async () => {
  const input = await collectDutyBriefingInput(
    mockDeps({
      userId: 'owner',
      threadStore: { list: async () => [{ id: 'thr-e' }, { id: 'thr-f' }] },
      dynamicTaskStore: {
        getAll: () => [
          // 过期 hold → expired
          {
            id: 'hold-ball-1',
            templateId: 'reminder',
            createdBy: 'hold-ball:sonnet',
            enabled: true,
            trigger: { type: 'once', fireAt: NOW - 2 * HOUR },
            deliveryThreadId: 'thr-e',
            params: { message: '持球唤醒' },
          },
          // 活跃 hold → activeCount
          {
            id: 'hold-ball-2',
            templateId: 'reminder',
            createdBy: 'hold-ball:opus',
            enabled: true,
            trigger: { type: 'once', fireAt: NOW + 1 * HOUR },
            deliveryThreadId: 'thr-f',
            params: {},
          },
          // 非 hold（createdBy 前缀不对）→ 忽略
          {
            id: 'reminder-x',
            templateId: 'reminder',
            createdBy: 'user',
            enabled: true,
            trigger: { type: 'once', fireAt: NOW - 1 * HOUR },
            deliveryThreadId: 'thr-g',
            params: {},
          },
          // disabled hold → 忽略
          {
            id: 'hold-ball-3',
            templateId: 'reminder',
            createdBy: 'hold-ball:gpt52',
            enabled: false,
            trigger: { type: 'once', fireAt: NOW - 1 * HOUR },
            deliveryThreadId: 'thr-h',
            params: {},
          },
        ],
      },
    }),
  );
  assert.equal(input.expiredHolds.length, 1, '只 1 颗过期 hold');
  assert.equal(input.expiredHolds[0].catId, 'sonnet');
  assert.equal(input.expiredHolds[0].threadId, 'thr-e');
  assert.equal(input.activeCount, 1, '1 颗活跃 hold 计入 active');
});

test('collectHolds: 其他用户 thread 的 hold 不应泄漏到当前 owner 简报', async () => {
  const input = await collectDutyBriefingInput(
    mockDeps({
      userId: 'owner',
      threadStore: { list: async () => [{ id: 'thr-owner' }] },
      dynamicTaskStore: {
        getAll: () => [
          {
            id: 'hold-ball-foreign',
            templateId: 'reminder',
            createdBy: 'hold-ball:sonnet',
            enabled: true,
            trigger: { type: 'once', fireAt: NOW - HOUR },
            deliveryThreadId: 'thr-foreign',
            params: { message: 'foreign hold' },
          },
        ],
      },
    }),
  );
  assert.equal(input.expiredHolds.length, 0);
  assert.equal(input.activeCount, 0);
});

test('collectMention（via 整合）: 尾部猫@co-creator 无 operator 回应 → 候选；有 operator 回应 → 不报', async () => {
  const candidateDeps = mockDeps({
    threadStore: { list: async () => [{ id: 'thr-m', lastActiveAt: NOW - 1 * HOUR, title: '需要决策的 thread' }] },
    messageStore: {
      getByThread: async () => [
        {
          id: 'msg-1',
          mentionsUser: true,
          catId: 'opus',
          content: '@co-creator 这个要不要做？',
          timestamp: NOW - 2 * HOUR,
          deliveredAt: NOW - 2 * HOUR,
        },
      ],
      getByThreadAfter: async () => [], // 无后续 → 球还在 operator 手上
    },
  });
  const withCandidate = await collectDutyBriefingInput(candidateDeps);
  assert.equal(withCandidate.mentionCandidates.length, 1);
  assert.equal(withCandidate.mentionCandidates[0].messageId, 'msg-1');
  assert.equal(withCandidate.mentionCandidates[0].catId, 'opus');

  // 有 operator（catId==null）回应 → 不报
  const answeredDeps = mockDeps({
    threadStore: { list: async () => [{ id: 'thr-m', lastActiveAt: NOW - 1 * HOUR, title: 't' }] },
    messageStore: {
      getByThread: async () => [
        { id: 'msg-1', mentionsUser: true, catId: 'opus', content: '@co-creator ?', timestamp: NOW - 2 * HOUR },
      ],
      getByThreadAfter: async () => [{ id: 'msg-2', catId: null, content: '好的' }],
    },
  });
  const answered = await collectDutyBriefingInput(answeredDeps);
  assert.equal(answered.mentionCandidates.length, 0, 'operator 回应了 → 球不在 operator 手上');
});

test('collectMention: system/briefing 消息不算 operator 回应，不能压掉 needs-user 候选', async () => {
  const input = await collectDutyBriefingInput(
    mockDeps({
      threadStore: { list: async () => [{ id: 'thr-m', lastActiveAt: NOW - HOUR, title: 't' }] },
      messageStore: {
        getByThread: async () => [
          { id: 'msg-1', mentionsUser: true, catId: 'opus', content: '@co-creator ?', timestamp: NOW - 2 * HOUR },
        ],
        getByThreadAfter: async () => [
          { id: 'msg-2', userId: 'system', catId: null, origin: 'briefing', content: '值班简报' },
        ],
      },
    }),
  );
  assert.equal(input.mentionCandidates.length, 1, 'system bubble 不是 operator 回复');
});

test('collectMention: 非近期活跃 thread（超 72h）跳过', async () => {
  const input = await collectDutyBriefingInput(
    mockDeps({
      threadStore: { list: async () => [{ id: 'thr-old', lastActiveAt: NOW - 100 * HOUR, title: 't' }] },
      messageStore: {
        getByThread: async () => [
          { id: 'm', mentionsUser: true, catId: 'opus', content: '@co-creator', timestamp: NOW - 100 * HOUR },
        ],
        getByThreadAfter: async () => [],
      },
    }),
  );
  assert.equal(input.mentionCandidates.length, 0, '超 72h 不扫');
});

test('collectVoidPasses（via 整合）: F167 C2 frictionSamples → voidPasses', async () => {
  const input = await collectDutyBriefingInput(
    mockDeps({
      f167SnapshotProvider: () => ({
        components: [
          {
            componentId: 'C2',
            frictionSamples: {
              'c2.verdict_without_pass_count': [
                { trigger: 'verdict_reject', firedAt: new Date(NOW - 20 * MIN).toISOString(), agentId: 'opus' },
              ],
            },
          },
        ],
      }),
    }),
  );
  assert.equal(input.voidPasses.length, 1);
  assert.equal(input.voidPasses[0].trigger, 'verdict_reject');
  assert.equal(input.voidPasses[0].catId, 'opus');
});

test('collectTasks: 只收 briefing owner 的 task；legacy 无 userId 仅 default-user 收', async () => {
  const store = {
    listByKind: async () => [
      {
        id: 'a',
        threadId: 't1',
        title: 'mine',
        ownerCatId: null,
        status: 'blocked',
        why: '',
        updatedAt: NOW,
        userId: 'u1',
      },
      {
        id: 'b',
        threadId: 't2',
        title: 'others',
        ownerCatId: null,
        status: 'blocked',
        why: '',
        updatedAt: NOW,
        userId: 'u2',
      },
      { id: 'c', threadId: 't3', title: 'legacy', ownerCatId: null, status: 'blocked', why: '', updatedAt: NOW },
    ],
  };
  const own = await collectDutyBriefingInput(
    mockDeps({
      userId: 'u1',
      taskStore: store,
    }),
  );
  assert.deepEqual(
    own.tasks.map((t) => t.id),
    ['a'],
  );

  const defaultUser = await collectDutyBriefingInput(
    mockDeps({
      userId: 'default-user',
      taskStore: store,
    }),
  );
  assert.deepEqual(
    defaultUser.tasks.map((t) => t.id),
    ['c'],
  );
});

test('collectZombies: 只统计 briefing owner 的 invocation records', async () => {
  const input = await collectDutyBriefingInput(
    mockDeps({
      userId: 'u1',
      invocationRecordStore: {
        scanAll: async () => [
          {
            id: 'mine',
            threadId: 'thr-1',
            userId: 'u1',
            targetCats: ['opus'],
            status: 'running',
            updatedAt: NOW - HOUR,
          },
          {
            id: 'other',
            threadId: 'thr-2',
            userId: 'u2',
            targetCats: ['sonnet'],
            status: 'running',
            updatedAt: NOW - HOUR,
          },
        ],
      },
      draftStore: { getByThread: async () => [] },
    }),
  );
  assert.equal(input.zombies.length, 1);
  assert.equal(input.zombies[0].invocationId, 'mine');
  assert.equal(input.activeCount, 0);
});

test('collectZombies: failed invocation 也进死球区（不是只看 running）', async () => {
  const input = await collectDutyBriefingInput(
    mockDeps({
      userId: 'u1',
      invocationRecordStore: {
        scanAll: async () => [
          {
            id: 'failed-1',
            threadId: 'thr-failed',
            userId: 'u1',
            targetCats: ['opus'],
            status: 'failed',
            updatedAt: NOW - HOUR,
            error: 'spend-limit',
          },
        ],
      },
      draftStore: { getByThread: async () => [] },
    }),
  );
  assert.equal(input.zombies.length, 1);
  assert.equal(input.zombies[0].invocationId, 'failed-1');
  assert.equal(input.zombies[0].detail, 'spend-limit');
});

test('collectVoidPasses: 缺 f167SnapshotProvider 时标 degradedSources，而不是伪装 0', async () => {
  const input = await collectDutyBriefingInput(mockDeps({ f167SnapshotProvider: undefined }));
  assert.deepEqual(input.voidPasses, []);
  assert.ok(input.degradedSources.includes('f167_telemetry'));
});

test('safeCollect: 单源抛错 → degradedSources 标记 + 该区空，整卡照发（对抗场景 3）', async () => {
  const input = await collectDutyBriefingInput(
    mockDeps({
      taskStore: {
        listByKind: async () => {
          throw new Error('redis down');
        },
      },
    }),
  );
  assert.ok(input.degradedSources.includes('tasks'), 'tasks 标记降级');
  assert.deepEqual(input.tasks, [], 'task 区空');
  // 其余源照常（空 mock）+ 整卡返回
  assert.ok(Array.isArray(input.zombies));
  assert.equal(input.bindingStatus, 'bound');
});

test('invocation: scanAll 缺失 → degradedSources 诚实标记，不能静默丢死球源', async () => {
  const input = await collectDutyBriefingInput(
    mockDeps({
      invocationRecordStore: {},
    }),
  );
  assert.ok(input.degradedSources.includes('invocation'));
  assert.deepEqual(input.zombies, []);
});

test('activeCount: doing task + 活跃 hold + 健康 invocation 三源相加', async () => {
  const input = await collectDutyBriefingInput(
    mockDeps({
      userId: 'default-user',
      taskStore: {
        listByKind: async () => [
          {
            id: 't-doing',
            title: '推进中',
            ownerCatId: 'opus',
            status: 'doing',
            why: '',
            updatedAt: NOW - 2 * HOUR,
            threadId: 'thr-a',
          },
        ],
      },
      threadStore: { list: async () => [{ id: 'thr-a' }, { id: 'thr-b' }, { id: 'thr-c' }] },
      dynamicTaskStore: {
        getAll: () => [
          {
            id: 'hold-ball-x',
            templateId: 'reminder',
            createdBy: 'hold-ball:opus',
            enabled: true,
            trigger: { type: 'once', fireAt: NOW + 1 * HOUR },
            deliveryThreadId: 'thr-b',
            params: {},
          },
        ],
      },
      invocationRecordStore: {
        scanAll: async () => [
          {
            id: 'inv-ok',
            threadId: 'thr-c',
            userId: 'default-user',
            targetCats: ['sonnet'],
            status: 'running',
            updatedAt: NOW - 1000,
          },
        ],
      },
      draftStore: { getByThread: async () => [{ invocationId: 'inv-ok', updatedAt: NOW - 500 }] }, // fresh → 健康
    }),
  );
  assert.equal(input.activeCount, 3, '1 doing + 1 活跃hold + 1 健康invocation');
  assert.ok(input.oldestHeartbeatMs >= 2 * HOUR, 'oldestHeartbeat = doing task 龄');
});

test('oldestHeartbeatMs: 只有健康 invocation、无 doing task 时，仍保留 invocation 心跳年龄（非 0）', async () => {
  const input = await collectDutyBriefingInput(
    mockDeps({
      invocationRecordStore: {
        scanAll: async () => [
          {
            id: 'inv-ok',
            threadId: 'thr-c',
            userId: 'default-user',
            targetCats: ['sonnet'],
            status: 'running',
            updatedAt: NOW - 3 * MIN,
          },
        ],
      },
      draftStore: { getByThread: async () => [] },
    }),
  );
  assert.equal(input.activeCount, 1);
  assert.ok(input.oldestHeartbeatMs >= 3 * MIN);
});

test('oldestHeartbeatMs: 有 fresh draft 时用 draft.updatedAt 而不是旧 record.updatedAt', async () => {
  const input = await collectDutyBriefingInput(
    mockDeps({
      invocationRecordStore: {
        scanAll: async () => [
          {
            id: 'inv-fresh',
            threadId: 'thr-c',
            userId: 'default-user',
            targetCats: ['sonnet'],
            status: 'running',
            updatedAt: NOW - 5 * HOUR,
          },
        ],
      },
      draftStore: { getByThread: async () => [{ invocationId: 'inv-fresh', updatedAt: NOW - 5 * MIN }] },
    }),
  );
  assert.ok(input.oldestHeartbeatMs < HOUR, 'fresh draft keeps healthy heartbeat fresh');
});
