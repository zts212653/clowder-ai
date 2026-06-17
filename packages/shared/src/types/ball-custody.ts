/**
 * F233 Phase B — Ball Custody Event Types（球权事件流 terminal schema）
 *
 * Append-only 球权事件流是简报与轨迹的单一账本（向前生效）。
 * plan: docs/plans/2026-06-14-f233-phase-b-ball-custody-event-stream.md
 *
 * 设计照 community-ops event-log + projector 先例（F168）：
 *   - 事件 append-only、幂等去重（sourceEventId）
 *   - projection 由事件纯投影、可 rebuild（replay）
 *   - transition() 纯函数、零 IO、零副作用
 *
 * KD-1：subjectKey 从现有痕迹派生（ball:thread / ball:task），不引入球 ID 新原语。
 */

// ---------------------------------------------------------------------------
// Event kinds（全 13 种，每种在 state-machine 转移表必有一行——INV-10 穷举钉死）
// ---------------------------------------------------------------------------

export type BallEventKind =
  | 'ball.handed' // 行首 @ 路由投递给某猫（payload: { fromCatId?, toCatId }）
  | 'ball.handed_cvo' // @co-creator（payload: { fromCatId?, intent: BallIntent }）
  | 'ball.void_pass' // F167 forced-pass guard / 路由守卫：说传了但无系统动作
  | 'ball.held' // hold_ball 设（payload: { catId, fireAt }）
  | 'ball.hold_expired' // hold fireAt 已过
  | 'invocation.started' // 持有者起 invocation
  | 'invocation.heartbeat' // draft 更新（F194 真心跳）
  | 'invocation.died' // error / spend-limit / timeout（payload: { reason, lastScanAt }）
  | 'task.blocked' // task 进入 blocked（→ blocked 状态，非 active）
  | 'task.unblocked' // 阻塞解除（owner ack 或外部满足）
  | 'task.idle_long' // blocked 长期无活动（→ zombie）
  | 'task.done' // task 完成（→ resolved，唯一正常终结；probe completes 也走这条）
  | 'ball.wake_sent'; // informational：bounces_back 唤醒已发，更新 lastWakeAt，不改 state（仅 blocked 接受）

export type BallEventClassification = 'state-changing' | 'informational';

// ---------------------------------------------------------------------------
// Core event record（照 CommunityEvent 结构）
// ---------------------------------------------------------------------------

export interface BallCustodyEvent {
  /**
   * 幂等 / 去重键，规范见 plan §F：
   * - route 类：`route:{messageId}`
   * - hold 类：`hold:{threadId}:{catId}:{fireAt}` / `holdexp:{…}:{fireAt}`
   * - invocation：`inv:{invocationId}:started|hb:{draftUpdatedAt}|died`
   * - task：`task:{taskId}:blocked:{blockedSinceAt}` / `:unblocked:{at}` / `:idle:{at}` / `:done`
   * - ball.wake_sent：`wake:{taskId}:{blockedSinceAt}:{at}`
   */
  sourceEventId: string;
  /** 派生标识（KD-1，不新建 ID）：`ball:thread:{threadId}` | `ball:task:{taskId}` */
  subjectKey: string;
  kind: BallEventKind;
  classification: BallEventClassification;
  payload: Record<string, unknown>;
  /** Unix timestamp (ms) */
  at: number;
}

// ---------------------------------------------------------------------------
// State machine types（全 7 态）
// ---------------------------------------------------------------------------

export type BallState =
  | 'new' // 初始态：projection 刚创建、首个事件尚未 apply（transient，首事件即转走，照 community 'new'）
  | 'active' // 正常推进（含 hold 持球等外部，heldUntil 可选）
  | 'blocked' // task 阻塞等 probe；简报按 ageMs 分 needsUser/staleBlocked；bounces_back 唤醒后仍 blocked
  | 'parked' // 搁置：handoff 给 operator，晾龄计时
  | 'dead' // 死球：invocation 死 / hold 过期，无心跳
  | 'void' // 虚空传球
  | 'zombie' // 僵尸：长期无活动放弃
  | 'resolved'; // 终态：task.done / (Phase C)安乐死

/** operator handoff 意图（ball.handed_cvo payload.intent）。 */
export type BallIntent = 'handoff' | 'fyi' | 'done_notify';

/** blocked task 的 on-resolve 二态（KD-5）。 */
export type BallResolveMode = 'completes' | 'bounces_back';

// ---------------------------------------------------------------------------
// Projection（rebuildable read model，照 CommunityObjectProjection）
// ---------------------------------------------------------------------------

export interface BallCustodyProjection {
  subjectKey: string;
  state: BallState;
  /** 当前持球 catId，或 'cvo' */
  holder: string | null;
  /** 仅 holder='cvo' 有意义 */
  intent: BallIntent | null;
  /** 仅 blocked 球有意义 */
  resolveMode: BallResolveMode | null;
  /** hold 球 fireAt（ball.held 设 / ball.hold_expired 判据）；非 hold 球 null */
  heldUntil: number | null;
  /** 进入当前 blocked episode 的时刻（= 该次 task.blocked 的 at）——episode identity（去重锚） */
  blockedSinceAt: number | null;
  /** 当前 episode 最近唤醒时刻；task.blocked(新 episode) 清空，ball.wake_sent 更新 */
  lastWakeAt: number | null;
  /** invocation.died 时记录的死前最后心跳点（AC-B1 简报「最后扫描点」） */
  lastScanAt: number | null;
  /** 晾龄基准（ageMs = now - lastStateChangeAt，纯派生不存） */
  lastStateChangeAt: number;
  lastEventAt: number;
  /** 消费事件数，rebuild 一致性校验 */
  appliedEventCount: number;
  /** 最后被 state machine reject 的事件（observability，不改 state） */
  lastRejectedEvent: BallCustodyEvent | null;
  createdAt: number;
  updatedAt: number;
}
