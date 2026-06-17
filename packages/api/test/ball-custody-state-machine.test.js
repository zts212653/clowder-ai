/**
 * F233 Phase B — ball-custody state machine（transition 纯函数）测试
 * node:test（对齐 api test runner，import dist）。plan §B 转移表 + INV-1~10。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  ALL_BALL_EVENT_KINDS,
  ALL_BALL_STATES,
  DEAD_BALL_ZOMBIE_GRACE_MS,
  transition,
} from '../dist/domains/ball-custody/ball-custody-state-machine.js';

function ev(kind, { payload = {}, at = 10_000, classification } = {}) {
  return {
    sourceEventId: 'src-1',
    subjectKey: 'ball:task:t1',
    kind,
    classification: classification ?? (kind === 'ball.wake_sent' ? 'informational' : 'state-changing'),
    payload,
    at,
  };
}
function snap(over = {}) {
  return { heldUntil: null, lastStateChangeAt: 0, ...over };
}

describe('ball-custody transition — 球流转', () => {
  it('ball.handed 从任意状态换 holder → active（resolved=reopen）', () => {
    for (const from of ALL_BALL_STATES) {
      assert.deepStrictEqual(transition(from, ev('ball.handed', { payload: { toCatId: 'opus' } }), snap()), {
        ok: true,
        next: 'active',
      });
    }
  });

  it('ball.handed_cvo intent 三态：handoff→parked / done_notify→resolved / fyi→不变', () => {
    assert.deepStrictEqual(transition('active', ev('ball.handed_cvo', { payload: { intent: 'handoff' } }), snap()), {
      ok: true,
      next: 'parked',
    });
    assert.deepStrictEqual(
      transition('active', ev('ball.handed_cvo', { payload: { intent: 'done_notify' } }), snap()),
      {
        ok: true,
        next: 'resolved',
      },
    );
    // fyi 知会，不产搁置球（INV-7）→ state 不变
    assert.deepStrictEqual(transition('active', ev('ball.handed_cvo', { payload: { intent: 'fyi' } }), snap()), {
      ok: true,
      next: 'active',
    });
  });

  it('ball.handed_cvo 缺/坏 intent → bad_payload', () => {
    assert.strictEqual(transition('active', ev('ball.handed_cvo', { payload: {} }), snap()).ok, false);
    assert.strictEqual(
      transition('active', ev('ball.handed_cvo', { payload: { intent: 'nonsense' } }), snap()).ok,
      false,
    );
  });
});

describe('ball-custody transition — hold 守卫', () => {
  it('ball.held 从 active → active（heldUntil 由 projector 设）', () => {
    assert.deepStrictEqual(
      transition('active', ev('ball.held', { payload: { catId: 'opus', fireAt: 99_999 } }), snap()),
      {
        ok: true,
        next: 'active',
      },
    );
  });
  it('ball.hold_expired 需 heldUntil≠null → dead；heldUntil=null → reject', () => {
    assert.deepStrictEqual(transition('active', ev('ball.hold_expired'), snap({ heldUntil: 99_999 })), {
      ok: true,
      next: 'dead',
    });
    assert.strictEqual(transition('active', ev('ball.hold_expired'), snap({ heldUntil: null })).ok, false);
  });
});

describe('ball-custody transition — 死球 + 迟到心跳 grace（INV-8/对抗5）', () => {
  it('invocation.died active/blocked → dead', () => {
    assert.deepStrictEqual(
      transition('active', ev('invocation.died', { payload: { reason: 'spend_limit' } }), snap()),
      {
        ok: true,
        next: 'dead',
      },
    );
    assert.deepStrictEqual(transition('blocked', ev('invocation.died'), snap()), { ok: true, next: 'dead' });
  });
  it('迟到心跳：grace 内复活 active，超 grace reject（died.at = lastStateChangeAt）', () => {
    assert.deepStrictEqual(
      transition(
        'dead',
        ev('invocation.heartbeat', { at: DEAD_BALL_ZOMBIE_GRACE_MS - 1 }),
        snap({ lastStateChangeAt: 0 }),
      ),
      { ok: true, next: 'active' },
    );
    assert.strictEqual(
      transition(
        'dead',
        ev('invocation.heartbeat', { at: DEAD_BALL_ZOMBIE_GRACE_MS + 1 }),
        snap({ lastStateChangeAt: 0 }),
      ).ok,
      false,
    );
  });
  it('active heartbeat 续 active', () => {
    assert.deepStrictEqual(transition('active', ev('invocation.heartbeat'), snap()), { ok: true, next: 'active' });
  });
});

describe('ball-custody transition — task 生命周期', () => {
  it('task.blocked → blocked（不落 active，P1-3）', () => {
    assert.deepStrictEqual(transition('active', ev('task.blocked'), snap()), { ok: true, next: 'blocked' });
  });
  it('task.unblocked blocked/zombie → active', () => {
    assert.deepStrictEqual(transition('blocked', ev('task.unblocked'), snap()), { ok: true, next: 'active' });
    assert.deepStrictEqual(transition('zombie', ev('task.unblocked'), snap()), { ok: true, next: 'active' });
  });
  it('task.idle_long → zombie', () => {
    assert.deepStrictEqual(transition('blocked', ev('task.idle_long'), snap()), { ok: true, next: 'zombie' });
  });
  it('task.done 从任意状态 → resolved', () => {
    for (const from of ALL_BALL_STATES) {
      assert.deepStrictEqual(transition(from, ev('task.done'), snap()), { ok: true, next: 'resolved' });
    }
  });
});

describe('ball-custody transition — 虚空 + 唤醒', () => {
  it('ball.void_pass active/blocked/parked → void', () => {
    assert.deepStrictEqual(transition('active', ev('ball.void_pass'), snap()), { ok: true, next: 'void' });
    assert.deepStrictEqual(transition('blocked', ev('ball.void_pass'), snap()), { ok: true, next: 'void' });
  });
  it('ball.wake_sent blocked → blocked（informational，lastWakeAt 由 projector 更新）', () => {
    assert.deepStrictEqual(transition('blocked', ev('ball.wake_sent'), snap()), { ok: true, next: 'blocked' });
  });
  it('ball.wake_sent 非 blocked → reject（informational ignore，不污染 lastRejected）', () => {
    assert.strictEqual(transition('active', ev('ball.wake_sent'), snap()).ok, false);
    assert.strictEqual(transition('resolved', ev('ball.wake_sent'), snap()).ok, false);
  });
});

describe('INV-10 完整性穷举：全 state × event 无未定义', () => {
  it('每个 (state, event) transition 返回 well-formed result，不 throw', () => {
    assert.strictEqual(ALL_BALL_STATES.length, 8); // new + 7
    assert.strictEqual(ALL_BALL_EVENT_KINDS.length, 13);
    for (const state of ALL_BALL_STATES) {
      for (const kind of ALL_BALL_EVENT_KINDS) {
        const r = transition(
          state,
          ev(kind, { payload: { intent: 'handoff', fireAt: 1, toCatId: 'x', reason: 'r' } }),
          snap({ heldUntil: 1, lastStateChangeAt: 0 }),
        );
        assert.ok('ok' in r);
        if (r.ok) {
          assert.ok(ALL_BALL_STATES.includes(r.next));
        } else {
          assert.ok(['invalid_transition', 'bad_payload'].includes(r.reason));
        }
      }
    }
  });
});
