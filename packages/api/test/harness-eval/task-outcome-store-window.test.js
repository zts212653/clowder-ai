import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import { TaskOutcomeEpisodeStore } from '../../dist/infrastructure/harness-eval/task-outcome/task-outcome-store.js';

// F245 Phase B Task 1 — cancel 通道只读时间窗查询
// 契约: 按 createdAt(ISO TEXT, 字典序==时间序) 半开窗 [sinceMs, untilMs) 查询，
//      可选 category 粗筛（真实列 a1/a2/proxy）。record.type 精筛留给 Adapter 层。
//      只读 SELECT，不碰写侧（KD-4 read-model 边界）。
describe('TaskOutcomeEpisodeStore.listSignalsInWindow (F245 Phase B)', () => {
  /** @type {TaskOutcomeEpisodeStore} */
  let store;
  /** @type {string} */
  let episodeId;

  beforeEach(() => {
    store = new TaskOutcomeEpisodeStore(':memory:');
    const ep = store.createEpisode({ trigger: 'user_ask', threadId: 't1', participants: ['opus'] });
    episodeId = ep.episodeId;
  });

  it('returns signals whose createdAt falls within the window, ascending, record parsed', () => {
    store.appendSignal(episodeId, { category: 'a2', record: { type: 'permission_cancel', toolName: 'x' } });
    store.appendSignal(episodeId, { category: 'proxy', record: { type: 'cancel_burst', count: 3 } });
    const now = Date.now();
    const got = store.listSignalsInWindow(now - 60_000, now + 60_000);
    assert.equal(got.length, 2);
    // record 已解析为对象（非 JSON 字符串）
    assert.equal(typeof got[0].record, 'object');
    assert.ok(got.every((s) => typeof s.createdAt === 'string'));
  });

  it('excludes signals outside the window (past + future)', () => {
    store.appendSignal(episodeId, { category: 'a2', record: { type: 'permission_cancel' } });
    const now = Date.now();
    assert.equal(store.listSignalsInWindow(now - 7_200_000, now - 3_600_000).length, 0); // past
    assert.equal(store.listSignalsInWindow(now + 3_600_000, now + 7_200_000).length, 0); // future
  });

  it('filters by category when provided', () => {
    store.appendSignal(episodeId, { category: 'a2', record: { type: 'permission_cancel' } });
    store.appendSignal(episodeId, { category: 'proxy', record: { type: 'cancel_burst' } });
    store.appendSignal(episodeId, { category: 'a1', record: { type: 'world_truth' } });
    const now = Date.now();
    const got = store.listSignalsInWindow(now - 60_000, now + 60_000, ['a2', 'proxy']);
    assert.equal(got.length, 2);
    assert.ok(got.every((s) => s.category === 'a2' || s.category === 'proxy'));
  });

  it('treats untilMs as exclusive and sinceMs as inclusive (half-open)', () => {
    store.appendSignal(episodeId, { category: 'a2', record: { type: 'permission_cancel' } });
    const now = Date.now();
    const all = store.listSignalsInWindow(now - 60_000, now + 60_000);
    assert.equal(all.length, 1);
    const ts = Date.parse(all[0].createdAt);
    assert.equal(store.listSignalsInWindow(ts, ts).length, 0); // untilMs == ts → excluded
    assert.equal(store.listSignalsInWindow(ts, ts + 1).length, 1); // untilMs == ts+1 → included
    assert.equal(store.listSignalsInWindow(ts, ts + 1000).length, 1); // sinceMs == ts → included
  });

  it('returns empty array when no signals exist', () => {
    const now = Date.now();
    assert.deepEqual(store.listSignalsInWindow(now - 60_000, now + 60_000), []);
  });
});
