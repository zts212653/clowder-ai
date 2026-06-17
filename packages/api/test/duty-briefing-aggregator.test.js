/**
 * F233 Phase A — BallCustodyAggregator 纯函数测试（Task 2.1-2.4）。
 * 纯函数：喂 fixture input → 断言分类/排序/降级。无 store（只读 trivial，AC-A5）。
 * store 查询行为的覆盖在 duty-briefing-collect-redis.test.js（Redis-backed，Task 2.5）。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

const { aggregateDutyBriefing } = await import('../dist/domains/cats/services/duty-briefing/BallCustodyAggregator.js');

const NOW = 1_700_000_000_000;
const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const MIN = 60 * 1000;

function baseInput(over = {}) {
  return {
    tasks: [],
    zombies: [],
    expiredHolds: [],
    voidPasses: [],
    mentionCandidates: [],
    threadTitles: {},
    activeCount: 0,
    oldestHeartbeatMs: 0,
    bindingStatus: 'bound',
    degradedSources: [],
    now: NOW,
    ...over,
  };
}

test('AC-A1: spike 三球同型 → staleBlocked / deadBalls / voidPasses 各一，confidence 全 structured', () => {
  const b = aggregateDutyBriefing(
    baseInput({
      tasks: [
        {
          id: 't-repo-inbox',
          title: '启用 Repo Inbox',
          ownerCatId: 'codex',
          status: 'blocked',
          why: '等 You 重启 API',
          updatedAt: NOW - 30 * DAY,
          threadId: 'thread-ops',
        },
      ],
      zombies: [
        {
          invocationId: 'inv-47',
          threadId: 'thread-f167',
          catId: 'opus-47',
          recordUpdatedAt: NOW - 3.4 * HOUR,
          detail: 'spend-limit',
        },
      ],
      voidPasses: [{ trigger: 'verdict_reject', firedAtMs: NOW - 20 * MIN, catId: 'opus' }],
    }),
  );

  // 睡美人（30天 blocked task）
  assert.equal(b.staleBlocked.length, 1);
  assert.equal(b.staleBlocked[0].kind, 'task');
  assert.equal(b.staleBlocked[0].confidence, 'structured');
  assert.equal(b.staleBlocked[0].anchor.taskId, 't-repo-inbox');
  assert.ok(b.staleBlocked[0].ageMs >= 30 * DAY);

  // 死球（invocation zombie）
  assert.equal(b.deadBalls.length, 1);
  assert.equal(b.deadBalls[0].kind, 'invocation-death');
  assert.equal(b.deadBalls[0].confidence, 'structured');
  assert.equal(b.deadBalls[0].anchor.threadId, 'thread-f167');
  assert.equal(b.deadBalls[0].holder, 'opus-47');

  // 虚空传球（F167，锚点降级恒空）
  assert.equal(b.voidPasses.length, 1);
  assert.equal(b.voidPasses[0].kind, 'void-pass');
  assert.equal(b.voidPasses[0].confidence, 'structured');
  assert.deepEqual(b.voidPasses[0].anchor, {}, 'void-pass 锚点恒空（HMAC 不可逆）');

  assert.equal(b.counts.staleBlocked, 1);
  assert.equal(b.counts.dead, 1);
  assert.equal(b.counts.voidPass, 1);
});

test('AC-A2: 正常活跃球不入异常区，仅 counts.active 计入', () => {
  const b = aggregateDutyBriefing(
    baseInput({
      tasks: [
        {
          id: 't-doing',
          title: '正常推进中',
          ownerCatId: 'opus',
          status: 'doing',
          why: '',
          updatedAt: NOW - 2 * HOUR,
          threadId: 'thr-a',
        },
        {
          id: 't-fresh-block',
          title: '刚 block',
          ownerCatId: 'sonnet',
          status: 'blocked',
          why: '等 CI',
          updatedAt: NOW - 1 * HOUR,
          threadId: 'thr-b',
        },
      ],
      activeCount: 9,
      oldestHeartbeatMs: 36 * HOUR,
    }),
  );
  assert.equal(b.needsUser.length, 0, 'doing 正常 + blocked <1d 不进 needsUser（防过敏）');
  assert.equal(b.staleBlocked.length, 0);
  assert.equal(b.deadBalls.length, 0);
  assert.equal(b.counts.active, 9);
  assert.equal(b.healthy.count, 9);
  assert.equal(b.healthy.oldestHeartbeatMs, 36 * HOUR);
});

test('healthy.oldestHeartbeatMs 可来自 invocation，不要求一定有 doing task', () => {
  const b = aggregateDutyBriefing(
    baseInput({
      activeCount: 1,
      oldestHeartbeatMs: 3 * HOUR,
    }),
  );
  assert.equal(b.healthy.count, 1);
  assert.equal(b.healthy.oldestHeartbeatMs, 3 * HOUR);
});

test('AC-A3: needsUser 晾龄降序 + structured(task) 与 heuristic(mention) 可区分', () => {
  const b = aggregateDutyBriefing(
    baseInput({
      tasks: [
        {
          id: 't-block-3d',
          title: 'blocked 3天',
          ownerCatId: 'gpt52',
          status: 'blocked',
          why: '等 review',
          updatedAt: NOW - 3 * DAY,
          threadId: 'thr-c',
        },
      ],
      mentionCandidates: [
        {
          threadId: 'thr-d',
          messageId: 'm-99',
          catId: 'opus',
          title: '@co-creator 看下这个',
          timestamp: NOW - 5 * DAY,
        },
      ],
    }),
  );
  assert.equal(b.needsUser.length, 2);
  assert.ok(b.needsUser[0].ageMs >= b.needsUser[1].ageMs, '晾龄降序');
  const mention = b.needsUser.find((e) => e.kind === 'mention-heuristic');
  assert.ok(mention, 'mention 候选存在');
  assert.equal(mention.confidence, 'heuristic');
  assert.equal(mention.anchor.messageId, 'm-99');
  const task = b.needsUser.find((e) => e.kind === 'task');
  assert.ok(task, '结构化 task 候选存在');
  assert.equal(task.confidence, 'structured');
  assert.equal(task.anchor.taskId, 't-block-3d');
});

test('部分降级：degradedSources 透传（对抗场景 3：单源失败整卡照发）', () => {
  const b = aggregateDutyBriefing(baseInput({ degradedSources: ['f167-telemetry'] }));
  assert.deepEqual(b.degradedSources, ['f167-telemetry']);
  assert.equal(b.bindingStatus, 'bound');
  assert.ok(Array.isArray(b.needsUser) && Array.isArray(b.deadBalls));
});

test('过期 hold → deadBalls（zombie-hold 形态，holder=catId）', () => {
  const b = aggregateDutyBriefing(
    baseInput({
      expiredHolds: [{ threadId: 'thr-e', catId: 'sonnet', fireAt: NOW - 2 * HOUR, message: '持球唤醒' }],
    }),
  );
  assert.equal(b.deadBalls.length, 1);
  assert.equal(b.deadBalls[0].kind, 'hold-expired');
  assert.equal(b.deadBalls[0].holder, 'sonnet');
  assert.equal(b.deadBalls[0].anchor.threadId, 'thr-e');
});

test('threadTitles 传入时 zombie/hold 标题用 thread 名而非纯 catId', () => {
  const b = aggregateDutyBriefing(
    baseInput({
      zombies: [
        { invocationId: 'inv-z1', threadId: 'thr-f', catId: 'gpt52', recordUpdatedAt: NOW - DAY, detail: 'no_tracker' },
      ],
      expiredHolds: [{ threadId: 'thr-g', catId: 'opus-48', fireAt: NOW - 3 * HOUR, message: '等 CI' }],
      threadTitles: {
        'thr-f': 'f233 球权流转图',
        'thr-g': 'f198 拯救宪宪倒计时',
      },
    }),
  );
  assert.equal(b.deadBalls.length, 2);
  const zombie = b.deadBalls.find((e) => e.kind === 'invocation-death');
  assert.equal(zombie.title, 'f233 球权流转图', 'zombie 标题用 thread 名');
  assert.equal(zombie.holder, 'gpt52', 'holder 保留 catId');
  const hold = b.deadBalls.find((e) => e.kind === 'hold-expired');
  assert.equal(hold.title, 'f198 拯救宪宪倒计时', 'hold 标题用 thread 名');
  assert.equal(hold.holder, 'opus-48');
});

test('threadTitles 缺失时 zombie/hold 退化到 catId 标题', () => {
  const b = aggregateDutyBriefing(
    baseInput({
      zombies: [{ invocationId: 'inv-z2', threadId: 'thr-unknown', catId: 'fable-5', recordUpdatedAt: NOW - 2 * DAY }],
      // threadTitles 空 = 无匹配
    }),
  );
  assert.equal(b.deadBalls.length, 1);
  assert.equal(b.deadBalls[0].title, 'fable-5 无心跳', 'fallback 到 catId 标题');
});
