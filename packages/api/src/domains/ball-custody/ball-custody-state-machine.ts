/**
 * F233 Phase B — Ball Custody State Machine（transition 纯函数）
 *
 * 纯函数 — 零 IO、零 Redis、零副作用。照 community-state-machine 的**表驱动**模式
 * （TRANSITION_TABLE 而非 if-chain，降单函数 cognitive complexity）。
 * 调用方（projector）负责持久化 + 字段 effect（heldUntil/blockedSinceAt/lastWakeAt）。
 *
 * INV-10（完整性）：全 8 state × 13 event 的每格行为确定（转移 or 显式 reject），穷举测试钉死。
 * 复杂守卫拆成独立 resolver：
 *   - ball.handed_cvo：payload.intent 三态（handoff→parked / done_notify→resolved / fyi→不变）
 *   - ball.hold_expired：需 snapshot.heldUntil≠null
 *   - invocation.heartbeat from dead：迟到心跳 grace（died.at < hb.at ≤ died.at+GRACE，died.at=lastStateChangeAt）
 */

import type { BallCustodyEvent, BallCustodyProjection, BallIntent, BallState } from '@cat-cafe/shared';

/** 死球迟到心跳 grace（复用 F194/Phase A DEAD_BALL_ZOMBIE_GRACE_MS=600s）。 */
export const DEAD_BALL_ZOMBIE_GRACE_MS = 600_000;

export const ALL_BALL_STATES: BallState[] = [
  'new',
  'active',
  'blocked',
  'parked',
  'dead',
  'void',
  'zombie',
  'resolved',
];

export const ALL_BALL_EVENT_KINDS: BallCustodyEvent['kind'][] = [
  'ball.handed',
  'ball.handed_cvo',
  'ball.void_pass',
  'ball.held',
  'ball.hold_expired',
  'invocation.started',
  'invocation.heartbeat',
  'invocation.died',
  'task.blocked',
  'task.unblocked',
  'task.idle_long',
  'task.done',
  'ball.wake_sent',
];

export type BallTransitionReject = 'invalid_transition' | 'bad_payload';

export type BallTransitionResult = { ok: true; next: BallState } | { ok: false; reason: BallTransitionReject };

/** transition 守卫只需 projection 的这几字段（窄输入，好测）。 */
export type BallTransitionSnapshot = Pick<BallCustodyProjection, 'heldUntil' | 'lastStateChangeAt'>;

const ok = (next: BallState): BallTransitionResult => ({ ok: true, next });
const reject = (reason: BallTransitionReject): BallTransitionResult => ({ ok: false, reason });

const set = (...states: BallState[]): Set<BallState> => new Set(states);
const VALID_INTENTS: BallIntent[] = ['handoff', 'fyi', 'done_notify'];

// ─── 复杂守卫 resolver（每个独立、低复杂度）────────────────────────────────

/** ball.handed_cvo：intent 校验先于 from 限制（bad_payload 优先），三态分流。 */
function resolveHandedCvo(event: BallCustodyEvent, current: BallState): BallTransitionResult {
  const intent = event.payload.intent;
  if (typeof intent !== 'string' || !VALID_INTENTS.includes(intent as BallIntent)) return reject('bad_payload');
  if (!set('new', 'active', 'blocked', 'parked', 'void', 'zombie').has(current)) return reject('invalid_transition');
  if (intent === 'handoff') return ok('parked');
  if (intent === 'done_notify') return ok('resolved');
  return ok(current); // fyi 知会，不产搁置球（INV-7）→ state 不变
}

/** ball.hold_expired：仅 active 且持球（heldUntil≠null）→ dead。 */
function resolveHoldExpired(snapshot: BallTransitionSnapshot, current: BallState): BallTransitionResult {
  return current === 'active' && snapshot.heldUntil != null ? ok('dead') : reject('invalid_transition');
}

/** invocation.heartbeat：active 续；dead 须迟到心跳在 grace 窗口内（>0 且 ≤GRACE）才复活。 */
function resolveHeartbeat(
  event: BallCustodyEvent,
  snapshot: BallTransitionSnapshot,
  current: BallState,
): BallTransitionResult {
  if (current === 'active') return ok('active');
  if (current === 'dead') {
    const sinceDeath = event.at - snapshot.lastStateChangeAt;
    return sinceDeath > 0 && sinceDeath <= DEAD_BALL_ZOMBIE_GRACE_MS ? ok('active') : reject('invalid_transition');
  }
  return reject('invalid_transition');
}

// ─── 转移表（静态 from→to）+ resolver 出口（动态）────────────────────────

type StaticRule = { from: Set<BallState> | '*'; to: BallState };
type DynamicRule = {
  resolve: (event: BallCustodyEvent, snapshot: BallTransitionSnapshot, current: BallState) => BallTransitionResult;
};

const STATIC_TABLE: Partial<Record<BallCustodyEvent['kind'], StaticRule>> = {
  'ball.handed': { from: '*', to: 'active' }, // 任意（含 resolved=reopen）→ active
  'ball.void_pass': { from: set('new', 'active', 'blocked', 'parked'), to: 'void' },
  'ball.held': { from: set('new', 'active'), to: 'active' }, // heldUntil 由 projector 设
  'invocation.started': { from: set('active', 'blocked'), to: 'active' },
  'invocation.died': { from: set('active', 'blocked'), to: 'dead' }, // lastScanAt 由 projector 设
  'task.blocked': { from: set('new', 'active', 'void', 'zombie', 'parked'), to: 'blocked' }, // 不落 active（P1-3）
  'task.unblocked': { from: set('blocked', 'zombie'), to: 'active' },
  'task.idle_long': { from: set('active', 'blocked', 'parked', 'void'), to: 'zombie' },
  'task.done': { from: '*', to: 'resolved' }, // 唯一正常终结；resolved 幂等不复活
  'ball.wake_sent': { from: set('blocked'), to: 'blocked' }, // informational；非 blocked → reject（ignore）
};

const DYNAMIC_TABLE: Partial<Record<BallCustodyEvent['kind'], DynamicRule>> = {
  'ball.handed_cvo': { resolve: (e, _s, c) => resolveHandedCvo(e, c) },
  'ball.hold_expired': { resolve: (_e, s, c) => resolveHoldExpired(s, c) },
  'invocation.heartbeat': { resolve: resolveHeartbeat },
};

/**
 * 纯函数转移。current + event + snapshot → 下一状态 or reject。
 * 字段 effect（heldUntil/blockedSinceAt/lastWakeAt 更新）由 projector 在 apply 时处理，不在此。
 */
export function transition(
  current: BallState,
  event: BallCustodyEvent,
  snapshot: BallTransitionSnapshot,
): BallTransitionResult {
  const dynamic = DYNAMIC_TABLE[event.kind];
  if (dynamic) return dynamic.resolve(event, snapshot, current);

  const rule = STATIC_TABLE[event.kind];
  if (!rule) return reject('invalid_transition');
  if (rule.from !== '*' && !rule.from.has(current)) return reject('invalid_transition');
  return ok(rule.to);
}
