/**
 * F233 Phase B — B2 PR1: ball-custody 事件构造纯函数 + BallCustodyIngest（node:test，import dist）
 *
 * 覆盖：
 *  - buildHandedEvent / buildVoidPassEvent：§F sourceEventId 规范 + KD-1 subjectKey 派生 + classification
 *  - BallCustodyIngest.record：append + appended:true guard → apply（照 community-auto-tracking 先例）
 *    appended:false（重复 sourceEventId）→ 不二次 apply（projection 不漂移）
 *
 * Ingest 逻辑是纯协作（append→guard→apply），in-memory stub 足够；端到端 Redis 行为另有 -redis 测试。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { BallCustodyIngest } from '../dist/domains/ball-custody/BallCustodyIngest.js';
import { BallCustodyProjector } from '../dist/domains/ball-custody/BallCustodyProjector.js';
import { buildHandedEvent, buildVoidPassEvent } from '../dist/domains/ball-custody/ball-custody-events.js';

// dedup memLog（同 sourceEventId → appended:false），用于验证 ingest 的 appended:true guard。
// 注意：B1 projector.test 的 memLog 不 dedup（它测 projector 不测 ingest），这里必须 dedup。
function memLog() {
  const events = [];
  const seen = new Set();
  return {
    append: async (e) => {
      if (seen.has(e.sourceEventId)) return { appended: false, sequence: -1 };
      seen.add(e.sourceEventId);
      events.push(e);
      return { appended: true, sequence: events.length - 1 };
    },
    read: async (sk) => events.filter((e) => e.subjectKey === sk),
    listSubjects: async () => [...new Set(events.map((e) => e.subjectKey))],
  };
}
function memStore() {
  const m = new Map();
  return {
    get: async (k) => (m.has(k) ? JSON.parse(JSON.stringify(m.get(k))) : null),
    save: async (p) => {
      m.set(p.subjectKey, JSON.parse(JSON.stringify(p)));
    },
    listSubjectKeys: async () => [...m.keys()],
    delete: async (k) => {
      m.delete(k);
    },
  };
}
function setup() {
  const log = memLog();
  const store = memStore();
  const proj = new BallCustodyProjector(log, store);
  return { log, store, proj, ingest: new BallCustodyIngest(log, proj) };
}

describe('ball-custody-events — buildHandedEvent', () => {
  it('构造 ball.handed（§F sourceEventId + KD-1 subjectKey + payload）', () => {
    const e = buildHandedEvent({ fromCatId: 'opus', toCatId: 'codex', threadId: 'thr1', messageId: 'msg1', at: 1000 });
    assert.strictEqual(e.kind, 'ball.handed');
    assert.strictEqual(e.subjectKey, 'ball:thread:thr1');
    assert.strictEqual(e.classification, 'state-changing');
    assert.strictEqual(e.at, 1000);
    assert.deepStrictEqual(e.payload, { fromCatId: 'opus', toCatId: 'codex' });
  });

  it('sourceEventId 含 toCatId（细化 §F：一条消息 @ 多猫不撞键）', () => {
    const a = buildHandedEvent({ toCatId: 'catA', threadId: 'thr1', messageId: 'msg1', at: 1000 });
    const b = buildHandedEvent({ toCatId: 'catB', threadId: 'thr1', messageId: 'msg1', at: 1000 });
    assert.strictEqual(a.sourceEventId, 'route:msg1:catA');
    assert.notStrictEqual(a.sourceEventId, b.sourceEventId);
  });

  it('fromCatId 可选（用户首传 / 无前手）', () => {
    const e = buildHandedEvent({ toCatId: 'codex', threadId: 'thr1', messageId: 'msg1', at: 1000 });
    assert.strictEqual(e.payload.fromCatId, undefined);
    assert.strictEqual(e.payload.toCatId, 'codex');
  });
});

describe('ball-custody-events — buildVoidPassEvent', () => {
  it('构造 ball.void_pass（sourceEventId :void 后缀，与 handed 同消息不撞）', () => {
    const e = buildVoidPassEvent({ threadId: 'thr1', messageId: 'msg1', matchedPattern: 'cn_chiqiu', at: 2000 });
    assert.strictEqual(e.kind, 'ball.void_pass');
    assert.strictEqual(e.sourceEventId, 'route:msg1:void');
    assert.strictEqual(e.subjectKey, 'ball:thread:thr1');
    assert.strictEqual(e.classification, 'state-changing');
    assert.strictEqual(e.at, 2000);
    assert.strictEqual(e.payload.matchedPattern, 'cn_chiqiu');
  });

  it('matchedPattern 可选', () => {
    const e = buildVoidPassEvent({ threadId: 'thr1', messageId: 'msg1', at: 2000 });
    assert.strictEqual(e.kind, 'ball.void_pass');
    assert.strictEqual(e.sourceEventId, 'route:msg1:void');
  });
});

describe('BallCustodyIngest.record — append + appended:true guard → apply', () => {
  it('新事件 → append + apply（projection 落地 active + holder）', async () => {
    const { store, ingest } = setup();
    await ingest.record(buildHandedEvent({ toCatId: 'opus', threadId: 'thr1', messageId: 'm1', at: 100 }));
    const p = await store.get('ball:thread:thr1');
    assert.strictEqual(p.state, 'active');
    assert.strictEqual(p.holder, 'opus');
  });

  it('重复事件（同 sourceEventId）→ appended:false → 不二次 apply（appliedEventCount 不漂移）', async () => {
    const { store, ingest } = setup();
    const e = buildHandedEvent({ toCatId: 'opus', threadId: 'thr1', messageId: 'm1', at: 100 });
    await ingest.record(e);
    await ingest.record(e);
    const p = await store.get('ball:thread:thr1');
    assert.strictEqual(p.appliedEventCount, 1);
  });

  it('void_pass → projection.state=void（active 球转虚空）', async () => {
    const { store, ingest } = setup();
    await ingest.record(buildHandedEvent({ toCatId: 'opus', threadId: 'thr1', messageId: 'm1', at: 100 }));
    await ingest.record(buildVoidPassEvent({ threadId: 'thr1', messageId: 'm2', at: 200 }));
    const p = await store.get('ball:thread:thr1');
    assert.strictEqual(p.state, 'void');
  });

  it('handed 串行换 holder（opus→codex）', async () => {
    const { store, ingest } = setup();
    await ingest.record(buildHandedEvent({ toCatId: 'opus', threadId: 'thr1', messageId: 'm1', at: 100 }));
    await ingest.record(
      buildHandedEvent({ fromCatId: 'opus', toCatId: 'codex', threadId: 'thr1', messageId: 'm2', at: 200 }),
    );
    const p = await store.get('ball:thread:thr1');
    assert.strictEqual(p.state, 'active');
    assert.strictEqual(p.holder, 'codex');
  });
});

// racy async store：get 让出微任务，暴露并发 read-modify-save 的 lost update（云端 P1-2 复现）。
// 同步 Map store 不暴露 race；这里 get 后 await microtask，让并发 apply 都 read 同一 stale。
function racyStore() {
  const m = new Map();
  return {
    get: async (k) => {
      const v = m.has(k) ? JSON.parse(JSON.stringify(m.get(k))) : null;
      await Promise.resolve();
      await Promise.resolve();
      return v;
    },
    save: async (p) => {
      m.set(p.subjectKey, JSON.parse(JSON.stringify(p)));
    },
    listSubjectKeys: async () => [...m.keys()],
    delete: async (k) => {
      m.delete(k);
    },
  };
}

describe('BallCustodyIngest.record — per-subject 串行化（云端 P1-2: 并发 lost update）', () => {
  it('并发 record 同 subject → appliedEventCount 不丢失（apply 串行，不被 stale read clobber）', async () => {
    const log = memLog();
    const store = racyStore();
    const ingest = new BallCustodyIngest(log, new BallCustodyProjector(log, store));
    const N = 20;
    const events = Array.from({ length: N }, (_, i) =>
      buildHandedEvent({ toCatId: `cat${i}`, threadId: 'thr1', messageId: `m${i}`, at: 100 + i }),
    );
    await Promise.all(events.map((e) => ingest.record(e)));
    const p = await store.get('ball:thread:thr1');
    assert.strictEqual(p.appliedEventCount, N);
  });

  it('不同 subject 并发互不串行阻塞（各自独立 chain）', async () => {
    const log = memLog();
    const store = racyStore();
    const ingest = new BallCustodyIngest(log, new BallCustodyProjector(log, store));
    await Promise.all([
      ingest.record(buildHandedEvent({ toCatId: 'a', threadId: 'tA', messageId: 'mA', at: 100 })),
      ingest.record(buildHandedEvent({ toCatId: 'b', threadId: 'tB', messageId: 'mB', at: 100 })),
    ]);
    assert.strictEqual((await store.get('ball:thread:tA')).holder, 'a');
    assert.strictEqual((await store.get('ball:thread:tB')).holder, 'b');
  });
});
