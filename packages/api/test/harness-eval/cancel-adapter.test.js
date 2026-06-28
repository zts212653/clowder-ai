import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import { CancelAdapter } from '../../dist/infrastructure/harness-eval/friction/cancel-adapter.js';
import { TaskOutcomeEpisodeStore } from '../../dist/infrastructure/harness-eval/task-outcome/task-outcome-store.js';

// F245 Phase B Task 2 — CancelAdapter（cancel 通道，只读 task-outcome）
// 用真实 :memory: SQLite store（非 JS-traversal fake）——验证 category 耦合：
// permission_cancel(a2) + cancel_burst(proxy) 经 ['a2','proxy'] 粗筛 + record.type 精筛；
// 同为 a2 的 magic_word_ref / proposal_reject 必须被精筛排除（粗筛不够，精筛是硬要求）。

// record.timestamp 设成远古哨兵值——证明 signal.timestamp 取 store createdAt（窗口过滤列），
// 而非 record.timestamp（二者生产环境同刻，但窗口一致性要求用 createdAt）。
const SENTINEL_TS = '2020-01-01T00:00:00.000Z';

function permissionCancel(over = {}) {
  return {
    type: 'permission_cancel',
    toolName: 'Bash',
    paramsSummary: 'rm -rf /tmp/x',
    reason: 'wrong_direction',
    timestamp: SENTINEL_TS,
    catId: 'opus-48',
    threadId: 'th-1',
    sessionId: 's1',
    ...over,
  };
}

function cancelBurst(over = {}) {
  return { type: 'cancel_burst', value: 5, timestamp: SENTINEL_TS, threadId: 'th-2', ...over };
}

describe('CancelAdapter (F245 Phase B Task 2)', () => {
  /** @type {TaskOutcomeEpisodeStore} */
  let store;
  /** @type {string} */
  let episodeId;

  beforeEach(() => {
    store = new TaskOutcomeEpisodeStore(':memory:');
    episodeId = store.createEpisode({
      trigger: 'cat_initiated',
      threadId: 'th-1',
      participants: ['opus-48'],
    }).episodeId;
  });

  const wide = () => [Date.now() - 60_000, Date.now() + 60_000];

  it('channelId is "cancel"', () => {
    assert.equal(new CancelAdapter(store).channelId, 'cancel');
  });

  it('maps permission_cancel(a2) + cancel_burst(proxy) → FrictionSignal; excludes other a2 types', async () => {
    store.appendSignal(episodeId, { category: 'a2', record: permissionCancel() });
    store.appendSignal(episodeId, { category: 'proxy', record: cancelBurst() });
    // 同 a2 但非 cancel — 必须被 record.type 精筛排除
    store.appendSignal(episodeId, {
      category: 'a2',
      record: {
        type: 'magic_word_ref',
        eventId: 'e1',
        word: '下次一定',
        timestamp: SENTINEL_TS,
        threadId: 'th-1',
        catId: 'opus-48',
      },
    });
    store.appendSignal(episodeId, {
      category: 'a2',
      record: {
        type: 'proposal_reject',
        proposalId: 'p1',
        proposalType: 'thread',
        catId: 'opus-48',
        threadId: 'th-1',
        timestamp: SENTINEL_TS,
      },
    });

    const [since, until] = wide();
    const rows = store.listSignalsInWindow(since, until, ['a2', 'proxy']);
    const pcRow = rows.find((r) => r.record.type === 'permission_cancel');
    const cbRow = rows.find((r) => r.record.type === 'cancel_burst');

    const signals = await new CancelAdapter(store).pull(since, until);
    assert.equal(signals.length, 2, '只 permission_cancel + cancel_burst，magic_word_ref/proposal_reject 排除');

    const byId = new Map(signals.map((s) => [s.id, s]));

    const pc = byId.get(`cancel:${pcRow.id}`);
    assert.ok(pc, 'permission_cancel signal 存在');
    assert.equal(pc.channel, 'cancel');
    assert.equal(pc.catId, 'opus-48');
    assert.equal(pc.threadId, 'th-1');
    assert.equal(pc.tool, 'Bash');
    assert.equal(pc.severity, 'medium');
    assert.equal(pc.symptom, 'permission cancel (wrong_direction)');
    assert.equal(pc.rawRef, `${pcRow.id}`);
    assert.equal(pc.sourceEvidence, 'rm -rf /tmp/x');

    const cb = byId.get(`cancel:${cbRow.id}`);
    assert.ok(cb, 'cancel_burst signal 存在');
    assert.equal(cb.channel, 'cancel');
    assert.equal(cb.threadId, 'th-2');
    assert.equal(cb.severity, 'high');
    assert.equal(cb.symptom, 'cancel burst ×5');
    assert.equal(cb.rawRef, `${cbRow.id}`);
    assert.equal(cb.catId, undefined, 'cancel_burst record 无 catId → omit');
    assert.equal(cb.tool, undefined, 'cancel_burst 无 tool → omit');
  });

  it('signal.timestamp uses store createdAt (window-consistent), not record.timestamp', async () => {
    store.appendSignal(episodeId, { category: 'a2', record: permissionCancel() });
    const [since, until] = wide();
    const row = store.listSignalsInWindow(since, until, ['a2', 'proxy'])[0];
    const [signal] = await new CancelAdapter(store).pull(since, until);

    assert.equal(signal.timestamp, row.createdAt);
    assert.notEqual(signal.timestamp, SENTINEL_TS, '不取 record.timestamp 哨兵值');
  });

  it('idempotent: same source rows → identical id set across pulls', async () => {
    store.appendSignal(episodeId, { category: 'a2', record: permissionCancel() });
    store.appendSignal(episodeId, { category: 'proxy', record: cancelBurst() });

    const adapter = new CancelAdapter(store);
    const [since, until] = wide();
    const first = (await adapter.pull(since, until)).map((s) => s.id).sort();
    const second = (await adapter.pull(since, until)).map((s) => s.id).sort();

    assert.equal(first.length, 2);
    assert.deepEqual(second, first);
  });

  it('forwards window + coarse categories ["a2","proxy"] to store', async () => {
    const calls = [];
    const spy = {
      listSignalsInWindow: (s, u, c) => {
        calls.push([s, u, c]);
        return [];
      },
    };
    const out = await new CancelAdapter(spy).pull(111, 222);
    assert.deepEqual(out, []);
    assert.deepEqual(calls, [[111, 222, ['a2', 'proxy']]]);
  });

  it('empty window → []', async () => {
    const now = Date.now();
    assert.deepEqual(await new CancelAdapter(store).pull(now + 3_600_000, now + 7_200_000), []);
  });
});
