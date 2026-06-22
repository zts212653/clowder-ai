import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { FrictionAggregator } from '../../dist/infrastructure/harness-eval/friction/friction-aggregator.js';

// F245 Phase B Task 6 — FrictionAggregator（4 通道合并 + dedup + intent filter）
// 用 stub IFrictionSignalSource：aggregator 是纯合并/去重/过滤逻辑，各 adapter 已单独测过。

function sig(over = {}) {
  return {
    id: 'paw-feel:m1#0',
    channel: 'paw-feel',
    timestamp: '2026-06-19T10:00:00.000Z',
    symptom: 'rg 噪音大',
    rawRef: 'm1#0',
    severity: 'medium',
    ...over,
  };
}

function source(channelId, signals, opts = {}) {
  return {
    channelId,
    pull: async (sinceMs, untilMs) => {
      if (opts.spy) opts.spy.push([channelId, sinceMs, untilMs]);
      if (opts.throws) throw new Error(`${channelId} boom`);
      return signals;
    },
  };
}

describe('FrictionAggregator (F245 Phase B Task 6)', () => {
  it('merges signals from all 4 sources', async () => {
    const agg = new FrictionAggregator([
      source('paw-feel', [sig({ id: 'paw-feel:a' })]),
      source('cancel', [sig({ id: 'cancel:1', channel: 'cancel', symptom: 'cancel burst ×3' })]),
      source('user-feedback', [sig({ id: 'user-feedback:fi_a', channel: 'user-feedback', symptom: 'cli_error: x' })]),
      source('eval-domain', [sig({ id: 'eval-domain:v#C#m', channel: 'eval-domain', symptom: 'm=2' })]),
    ]);
    const { signals: out } = await agg.collect(0, 9_999_999_999_999);
    assert.deepEqual(out.map((s) => s.id).sort(), [
      'cancel:1',
      'eval-domain:v#C#m',
      'paw-feel:a',
      'user-feedback:fi_a',
    ]);
  });

  it('dedups by deterministic id across sources', async () => {
    const dup = sig({ id: 'paw-feel:dup' });
    const agg = new FrictionAggregator([source('paw-feel', [dup]), source('cancel', [dup])]);
    const { signals: out } = await agg.collect(0, 9_999_999_999_999);
    assert.equal(out.length, 1, '同 id 跨源折叠成 1');
    assert.equal(out[0].id, 'paw-feel:dup');
  });

  it('intent filter: drops empty-symptom + paw-feel lessons-file ref; keeps genuine + machine channels', async () => {
    const agg = new FrictionAggregator([
      source('paw-feel', [
        sig({ id: 'paw-feel:genuine', symptom: 'rg 噪音大' }), // keep
        sig({ id: 'paw-feel:meta', symptom: 'feedback_workflow_preferences 的例子' }), // drop: 引用 lessons 文件
        sig({ id: 'paw-feel:empty', symptom: '   ' }), // drop: 空 symptom
      ]),
      // 机器派生通道：metric 名合法含 'feedback' 不应被误杀
      source('eval-domain', [sig({ id: 'eval-domain:x', channel: 'eval-domain', symptom: 'feedback_count=3' })]),
    ]);
    const { signals: out } = await agg.collect(0, 9_999_999_999_999);
    assert.deepEqual(out.map((s) => s.id).sort(), ['eval-domain:x', 'paw-feel:genuine']);
  });

  it('one source throwing → degrade-skip + surfaces droppedChannels (cloud R3 P2)', async () => {
    const agg = new FrictionAggregator([
      source('paw-feel', [sig({ id: 'paw-feel:a' }), sig({ id: 'paw-feel:b' })]),
      source('cancel', [], { throws: true }),
      source('user-feedback', [sig({ id: 'user-feedback:c', channel: 'user-feedback' })]),
    ]);
    const { signals: out, droppedChannels } = await agg.collect(0, 9_999_999_999_999);
    assert.deepEqual(out.map((s) => s.id).sort(), ['paw-feel:a', 'paw-feel:b', 'user-feedback:c']);
    assert.deepEqual(droppedChannels, ['cancel'], '抛错通道被记录，不静默假装完整');
  });

  it('sorts ascending by timestamp (id tie-break)', async () => {
    const agg = new FrictionAggregator([
      source('paw-feel', [
        sig({ id: 'paw-feel:late', timestamp: '2026-06-19T12:00:00.000Z' }),
        sig({ id: 'paw-feel:early', timestamp: '2026-06-19T08:00:00.000Z' }),
      ]),
    ]);
    const { signals: out } = await agg.collect(0, 9_999_999_999_999);
    assert.deepEqual(
      out.map((s) => s.id),
      ['paw-feel:early', 'paw-feel:late'],
    );
  });

  it('cloud R2 P2: sorts by epoch ms not lexicographic (offset-bearing timestamp)', async () => {
    // EvalDomain 透传带 offset 的 generatedAt：09:00+08:00 = 01:00Z 早于 02:00Z，但字典序会排反
    const agg = new FrictionAggregator([
      source('eval-domain', [
        sig({ id: 'offset', channel: 'eval-domain', timestamp: '2026-06-19T09:00:00+08:00' }),
        sig({ id: 'utc', channel: 'paw-feel', timestamp: '2026-06-19T02:00:00Z' }),
      ]),
    ]);
    const { signals: out } = await agg.collect(0, 9_999_999_999_999);
    assert.deepEqual(
      out.map((s) => s.id),
      ['offset', 'utc'],
      'offset 01:00Z < utc 02:00Z → epoch 正确排序（字典序会反）',
    );
  });

  it('forwards the same window to every source', async () => {
    const spy = [];
    const agg = new FrictionAggregator([source('paw-feel', [], { spy }), source('cancel', [], { spy })]);
    await agg.collect(111, 222);
    assert.deepEqual(spy.sort(), [
      ['cancel', 111, 222],
      ['paw-feel', 111, 222],
    ]);
  });

  it('no sources → empty signals + no dropped channels', async () => {
    const { signals, droppedChannels } = await new FrictionAggregator([]).collect(0, 1);
    assert.deepEqual(signals, []);
    assert.deepEqual(droppedChannels, []);
  });
});
