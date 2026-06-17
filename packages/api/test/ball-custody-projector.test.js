/**
 * F233 Phase B — BallCustodyProjector 逻辑测试（node:test，对齐 api test runner，import dist）
 * apply 字段 effect / reject 处理（INV-5）/ rebuild 幂等（INV-2）。
 * Projector apply 是纯逻辑（transition + 字段 effect），in-memory stub 足够；
 * ProjectionStore 的 Redis CRUD 行为另有 Redis-backed 测试。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { BallCustodyProjector } from '../dist/domains/ball-custody/BallCustodyProjector.js';

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
function memLog() {
  const events = [];
  return {
    append: async (e) => {
      events.push(e);
      return { appended: true, sequence: events.length - 1 };
    },
    read: async (sk) => events.filter((e) => e.subjectKey === sk),
    listSubjects: async () => [...new Set(events.map((e) => e.subjectKey))],
  };
}
function ev(kind, { payload = {}, at = 1000, classification, subjectKey = 'ball:task:t1' } = {}) {
  return {
    sourceEventId: `${kind}:${at}`,
    subjectKey,
    kind,
    classification: classification ?? (kind === 'ball.wake_sent' ? 'informational' : 'state-changing'),
    payload,
    at,
  };
}
function setup() {
  const log = memLog();
  const store = memStore();
  return { log, store, proj: new BallCustodyProjector(log, store) };
}

describe('BallCustodyProjector — apply 字段 effect', () => {
  it('ball.handed → active + holder', async () => {
    const { store, proj } = setup();
    await proj.apply(ev('ball.handed', { payload: { toCatId: 'opus' } }));
    const p = await store.get('ball:task:t1');
    assert.strictEqual(p.state, 'active');
    assert.strictEqual(p.holder, 'opus');
  });

  it('task.blocked → blocked + blockedSinceAt=at + lastWakeAt 清空', async () => {
    const { store, proj } = setup();
    await proj.apply(ev('task.blocked', { at: 5000 }));
    const p = await store.get('ball:task:t1');
    assert.strictEqual(p.state, 'blocked');
    assert.strictEqual(p.blockedSinceAt, 5000);
    assert.strictEqual(p.lastWakeAt, null);
  });

  it('ball.held → active + heldUntil + holder', async () => {
    const { store, proj } = setup();
    await proj.apply(ev('ball.held', { payload: { catId: 'opus', fireAt: 99_999 } }));
    const p = await store.get('ball:task:t1');
    assert.strictEqual(p.state, 'active');
    assert.strictEqual(p.heldUntil, 99_999);
    assert.strictEqual(p.holder, 'opus');
  });

  it('ball.handed_cvo handoff → parked + holder=cvo + intent', async () => {
    const { store, proj } = setup();
    await proj.apply(ev('ball.handed_cvo', { payload: { intent: 'handoff' } }));
    const p = await store.get('ball:task:t1');
    assert.strictEqual(p.state, 'parked');
    assert.strictEqual(p.holder, 'cvo');
    assert.strictEqual(p.intent, 'handoff');
  });

  it('invocation.died → dead + lastScanAt（从 payload）', async () => {
    const { proj, store } = setup();
    await proj.apply(ev('ball.handed', { payload: { toCatId: 'x' }, at: 100 }));
    await proj.apply(ev('invocation.died', { payload: { reason: 'spend_limit', lastScanAt: 888 }, at: 200 }));
    const p = await store.get('ball:task:t1');
    assert.strictEqual(p.state, 'dead');
    assert.strictEqual(p.lastScanAt, 888);
  });

  it('ball.wake_sent on blocked → lastWakeAt 更新；新 blocked episode 清空（砚砚卡点）', async () => {
    const { proj, store } = setup();
    await proj.apply(ev('task.blocked', { at: 1000 }));
    await proj.apply(ev('ball.wake_sent', { at: 2000 }));
    assert.strictEqual((await store.get('ball:task:t1')).lastWakeAt, 2000);
    // unblocked → 再 blocked = 新 episode，lastWakeAt 清空（防跨 episode 吞唤醒）
    await proj.apply(ev('task.unblocked', { at: 3000 }));
    await proj.apply(ev('task.blocked', { at: 4000 }));
    const p = await store.get('ball:task:t1');
    assert.strictEqual(p.blockedSinceAt, 4000);
    assert.strictEqual(p.lastWakeAt, null);
  });

  it('ball.handed 转球清 stale heldUntil（cloud review P2）', async () => {
    const { proj, store } = setup();
    // catX hold（fireAt=99999）
    await proj.apply(ev('ball.held', { payload: { catId: 'catX', fireAt: 99_999 }, at: 100 }));
    assert.strictEqual((await store.get('ball:task:t1')).heldUntil, 99_999);
    // fireAt 前转给 catY → 旧 hold stale，必须清（否则后续 hold_expired 误把 catY 的球判 dead）
    await proj.apply(ev('ball.handed', { payload: { toCatId: 'catY' }, at: 200 }));
    const p = await store.get('ball:task:t1');
    assert.strictEqual(p.holder, 'catY');
    assert.strictEqual(p.heldUntil, null);
  });

  it('离开 active 的转移清 heldUntil（failure-mode：task.blocked / handed_cvo / void_pass）', async () => {
    for (const leave of [
      ev('task.blocked', { at: 200 }),
      ev('ball.handed_cvo', { payload: { intent: 'handoff' }, at: 200 }),
      ev('ball.void_pass', { at: 200 }),
    ]) {
      const s = setup();
      await s.proj.apply(ev('ball.held', { payload: { catId: 'catX', fireAt: 99_999 }, at: 100 }));
      await s.proj.apply(leave);
      assert.strictEqual((await s.store.get('ball:task:t1')).heldUntil, null, `${leave.kind} should clear heldUntil`);
    }
  });

  it('离开 blocked 的转移清 blockedSinceAt/lastWakeAt（cloud P2-3 + failure-mode）', async () => {
    for (const exit of [
      ev('task.done', { at: 300 }), // → resolved
      ev('invocation.died', { at: 300 }), // → dead
      ev('ball.handed', { payload: { toCatId: 'y' }, at: 300 }), // → active
      ev('task.idle_long', { at: 300 }), // → zombie
    ]) {
      const s = setup();
      await s.proj.apply(ev('task.blocked', { at: 100 }));
      await s.proj.apply(ev('ball.wake_sent', { at: 200 })); // 设 lastWakeAt
      await s.proj.apply(exit);
      const p = await s.store.get('ball:task:t1');
      assert.strictEqual(p.blockedSinceAt, null, `${exit.kind} should clear blockedSinceAt`);
      assert.strictEqual(p.lastWakeAt, null, `${exit.kind} should clear lastWakeAt`);
    }
  });

  it('离开 parked 的转移清 intent（failure-mode：球转回猫不残留 operator intent）', async () => {
    const { proj, store } = setup();
    await proj.apply(ev('ball.handed_cvo', { payload: { intent: 'handoff' }, at: 100 })); // → parked + intent
    assert.strictEqual((await store.get('ball:task:t1')).intent, 'handoff');
    await proj.apply(ev('ball.handed', { payload: { toCatId: 'y' }, at: 200 })); // 转回猫 → active
    assert.strictEqual((await store.get('ball:task:t1')).intent, null);
  });
});

describe('BallCustodyProjector — reject 处理（INV-5）', () => {
  it('state-changing reject → 记 lastRejectedEvent，不改 state', async () => {
    const { proj, store } = setup();
    await proj.apply(ev('task.done', { at: 100 })); // → resolved
    await proj.apply(ev('invocation.died', { at: 200 })); // resolved 不接受 died → reject
    const p = await store.get('ball:task:t1');
    assert.strictEqual(p.state, 'resolved'); // 未复活
    assert.notStrictEqual(p.lastRejectedEvent, null);
    assert.strictEqual(p.lastRejectedEvent.kind, 'invocation.died');
  });

  it('informational reject（wake_sent 非 blocked）→ 不记 lastRejectedEvent（不污染）', async () => {
    const { proj, store } = setup();
    await proj.apply(ev('ball.handed', { payload: { toCatId: 'x' }, at: 100 })); // active
    await proj.apply(ev('ball.wake_sent', { at: 200 })); // active 不接受 wake_sent → informational reject
    const p = await store.get('ball:task:t1');
    assert.strictEqual(p.state, 'active');
    assert.strictEqual(p.lastRejectedEvent, null);
  });
});

describe('BallCustodyProjector — rebuild 幂等（INV-2 无漂移）', () => {
  it('apply 序列 → rebuild(replay) 得逐字段相同 projection', async () => {
    const { log, store, proj } = setup();
    const events = [
      ev('ball.handed', { payload: { toCatId: 'opus' }, at: 100 }),
      ev('task.blocked', { at: 200 }),
      ev('ball.wake_sent', { at: 300 }),
      ev('task.unblocked', { at: 400 }),
      ev('ball.handed_cvo', { payload: { intent: 'handoff' }, at: 500 }),
    ];
    for (const e of events) {
      await log.append(e);
      await proj.apply(e);
    }
    const before = await store.get('ball:task:t1');
    await proj.rebuild('ball:task:t1');
    const after = await store.get('ball:task:t1');
    assert.deepStrictEqual(after, before);
  });

  it('rebuild 后 appliedEventCount 与首次构建一致', async () => {
    const { log, store, proj } = setup();
    for (const e of [ev('task.blocked', { at: 1 }), ev('task.done', { at: 2 })]) {
      await log.append(e);
      await proj.apply(e);
    }
    const countBefore = (await store.get('ball:task:t1')).appliedEventCount;
    await proj.rebuild('ball:task:t1');
    assert.strictEqual((await store.get('ball:task:t1')).appliedEventCount, countBefore);
  });
});
