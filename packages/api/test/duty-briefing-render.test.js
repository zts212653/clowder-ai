/**
 * F233 Phase A — renderBriefingCard 测试（Task 4，纯函数无 Redis）。
 * 覆盖 AC-A4 ≤15 行截断 / KD-6 零按钮 / KD-3 healthy 一行 / heuristic 标记 / void-pass 无跳转 / tone。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

const { renderBriefingCard } = await import('../dist/domains/cats/services/duty-briefing/renderBriefingCard.js');

const NOW = 1_700_000_000_000;
const DAY = 86_400_000;
const HOUR = 3_600_000;
const MIN = 60_000;

function entry(over = {}) {
  return { kind: 'task', confidence: 'structured', title: '某球', ageMs: DAY, anchor: {}, ...over };
}

function briefing(over = {}) {
  return {
    generatedAt: NOW,
    bindingStatus: 'bound',
    counts: { active: 0, needsUser: 0, dead: 0, voidPass: 0, staleBlocked: 0 },
    needsUser: [],
    deadBalls: [],
    voidPasses: [],
    staleBlocked: [],
    healthy: { count: 0, oldestHeartbeatMs: 0 },
    degradedSources: [],
    ...over,
  };
}

test('card 结构 + KD-6 零按钮 + 计数行 + task 锚点链接', () => {
  const card = renderBriefingCard(
    briefing({
      counts: { active: 9, needsUser: 1, dead: 1, voidPass: 0, staleBlocked: 0 },
      needsUser: [entry({ title: 'Repo Inbox', anchor: { threadId: 'thr-x', taskId: 't1' }, ageMs: 30 * DAY })],
      deadBalls: [
        entry({ kind: 'invocation-death', title: 'opus-47 断流', anchor: { threadId: 'thr-f' }, ageMs: 3.4 * HOUR }),
      ],
      healthy: { count: 9, oldestHeartbeatMs: 36 * HOUR },
    }),
  );
  assert.equal(card.kind, 'card');
  assert.equal(card.v, 1);
  assert.equal(card.title, '☀️ 值班简报');
  assert.equal(card.tone, 'warning', '有异常 → warning');
  assert.equal(card.actions, undefined, 'KD-6: 零按钮');
  assert.ok(card.bodyMarkdown.includes('🔴 1 需要你'), '计数行');
  assert.ok(card.bodyMarkdown.includes('[Repo Inbox](/thread/thr-x)'), 'task 锚点 markdown 链接');
  assert.ok(card.bodyMarkdown.includes('晾30天'), '晾龄格式化');
  assert.ok(card.bodyMarkdown.includes('🟢 其余 9 颗正常'), 'KD-3 healthy 一行');
});

test('AC-A4: 默认态正文 ≤15 行 + 超限折叠（晾龄升序先砍）', () => {
  const many = Array.from({ length: 20 }, (_, i) => {
    const age = 20 - i;
    return entry({ title: `球${age - 1}`, anchor: { threadId: `t${age - 1}` }, ageMs: age * HOUR });
  });
  const card = renderBriefingCard(
    briefing({ counts: { active: 0, needsUser: 20, dead: 0, voidPass: 0, staleBlocked: 0 }, needsUser: many }),
  );
  const lines = card.bodyMarkdown.split('\n');
  assert.ok(lines.length <= 15, `正文 ≤15 行, got ${lines.length}`);
  assert.ok(card.bodyMarkdown.includes('另有'), '超限折叠提示');
  assert.ok(card.bodyMarkdown.includes('球19'), '保留晾龄最长（球19=20h）');
  assert.ok(!card.bodyMarkdown.includes('球0 '), '砍掉晾龄最短（球0=1h）');
});

test('AC-A4: 大量 staleBlocked 不能把 needsUser / deadBalls / voidPasses 全挤没（保区优先）', () => {
  const stale = Array.from({ length: 20 }, (_, i) =>
    entry({
      title: `睡美人${i}`,
      anchor: { threadId: `stale-${i}` },
      ageMs: (30 + i) * DAY,
    }),
  );
  const card = renderBriefingCard(
    briefing({
      counts: { active: 0, needsUser: 1, dead: 1, voidPass: 1, staleBlocked: stale.length },
      needsUser: [entry({ title: '需要你', anchor: { threadId: 'need-1' }, ageMs: 2 * HOUR })],
      deadBalls: [entry({ kind: 'invocation-death', title: '死球', anchor: { threadId: 'dead-1' }, ageMs: HOUR })],
      voidPasses: [entry({ kind: 'void-pass', title: '虚空', anchor: {}, ageMs: 30 * MIN })],
      staleBlocked: stale,
    }),
  );
  assert.ok(card.bodyMarkdown.includes('[需要你](/thread/need-1)'), 'needsUser 区保留');
  assert.ok(card.bodyMarkdown.includes('[死球](/thread/dead-1)'), 'deadBalls 区保留');
  assert.ok(card.bodyMarkdown.includes('虚空'), 'voidPasses 区保留');
});

test('heuristic 标「推断」+ void-pass 标「无跳转」（confidence 视觉可区分 AC-A3）', () => {
  const card = renderBriefingCard(
    briefing({
      counts: { active: 0, needsUser: 1, dead: 0, voidPass: 1, staleBlocked: 0 },
      needsUser: [
        entry({
          kind: 'mention-heuristic',
          confidence: 'heuristic',
          title: '@co-creator 看看',
          anchor: { threadId: 'thr-m', messageId: 'm1' },
          ageMs: 2 * DAY,
        }),
      ],
      voidPasses: [
        entry({
          kind: 'void-pass',
          confidence: 'structured',
          title: '虚空(verdict_reject)',
          anchor: {},
          ageMs: 20 * MIN,
        }),
      ],
    }),
  );
  assert.ok(card.bodyMarkdown.includes('推断'), 'heuristic → 推断标记');
  assert.ok(card.bodyMarkdown.includes('无跳转'), 'void-pass 无锚点 → 无跳转标记');
});

test('全健康（无异常）→ tone info + 仅计数行 + healthy 行（KD-3 异常优先）', () => {
  const card = renderBriefingCard(
    briefing({
      counts: { active: 12, needsUser: 0, dead: 0, voidPass: 0, staleBlocked: 0 },
      healthy: { count: 12, oldestHeartbeatMs: 5 * HOUR },
    }),
  );
  assert.equal(card.tone, 'info', '无异常 → info');
  assert.equal(card.actions, undefined);
  const lines = card.bodyMarkdown.split('\n');
  assert.equal(lines.length, 2, '仅计数行 + healthy 行（正常球不列条目）');
});

test('degraded binding → 头部告警行（INV-2 不静默）', () => {
  const card = renderBriefingCard(
    briefing({
      bindingStatus: 'degraded',
      counts: { active: 5, needsUser: 0, dead: 0, voidPass: 0, staleBlocked: 0 },
      healthy: { count: 5, oldestHeartbeatMs: HOUR },
    }),
  );
  assert.ok(card.bodyMarkdown.includes('绑定失效'), 'degraded 头部告警行');
});

test('collector degradedSources → 头部可见告警行（不能伪装全量健康）', () => {
  const card = renderBriefingCard(
    briefing({
      degradedSources: ['invocation', 'f167_telemetry'],
      counts: { active: 5, needsUser: 0, dead: 0, voidPass: 0, staleBlocked: 0 },
      healthy: { count: 5, oldestHeartbeatMs: HOUR },
    }),
  );
  assert.ok(card.bodyMarkdown.includes('数据降级：invocation / f167_telemetry'));
});

test('entryLine 渲染 holder 猫名（有 holder → @catId 显示）', () => {
  const card = renderBriefingCard(
    briefing({
      counts: { active: 0, needsUser: 1, dead: 0, voidPass: 0, staleBlocked: 0 },
      needsUser: [entry({ title: 'f233 球权流转图', anchor: { threadId: 'thr-t' }, ageMs: DAY, holder: 'fable-5' })],
    }),
  );
  assert.ok(card.bodyMarkdown.includes('@fable-5'), 'holder 猫名在 entry 中显示');
  assert.ok(card.bodyMarkdown.includes('f233 球权流转图'), '标题正确');
});

test('entryLine 无 holder 时不输出多余 @', () => {
  const card = renderBriefingCard(
    briefing({
      counts: { active: 0, needsUser: 1, dead: 0, voidPass: 0, staleBlocked: 0 },
      needsUser: [entry({ title: '无持球者球', anchor: { threadId: 'thr-u' }, ageMs: 2 * HOUR })],
    }),
  );
  assert.ok(!card.bodyMarkdown.includes('@'), '无 holder 不含 @');
});
