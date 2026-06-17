/**
 * BallCustodyProjector — 消费事件 → transition → 写 projection（F233 Phase B）
 *
 * 照 CommunityProjector（F168）：apply(event) = read projection → transition() →
 * 字段 effect + save；rebuild = delete + replay。
 *
 * **零外部副作用**（plan §E）：projector 只做纯状态投影 + store.save，绝不做唤醒投递
 * 等外部副作用（那些在 ProbeScheduler/WakeSender 的实时 tick 路径，rebuild 不重发）。
 *
 * Invariants:
 *  - 事件永不从 log 删除（事件 facts immutable）。
 *  - rejected transition 记 lastRejectedEvent（仅 state-changing），不改 state（INV-5）。
 *  - informational reject（ball.wake_sent 非 blocked）不记 lastRejectedEvent（不污染 observability）。
 *  - rebuild(replay) 得逐字段相同 projection（INV-2，无漂移）。
 */

import type { BallCustodyEvent, BallCustodyProjection, BallIntent } from '@cat-cafe/shared';
import type { IBallCustodyEventLog } from './BallCustodyEventLog.js';
import type { IBallCustodyProjectionStore } from './BallCustodyProjectionStore.js';
import { transition } from './ball-custody-state-machine.js';

const VALID_INTENTS: BallIntent[] = ['handoff', 'fyi', 'done_notify'];

function createInitialProjection(subjectKey: string, now: number): BallCustodyProjection {
  return {
    subjectKey,
    state: 'new',
    holder: null,
    intent: null,
    resolveMode: null,
    heldUntil: null,
    blockedSinceAt: null,
    lastWakeAt: null,
    lastScanAt: null,
    lastStateChangeAt: now,
    lastEventAt: now,
    appliedEventCount: 0,
    lastRejectedEvent: null,
    createdAt: now,
    updatedAt: now,
  };
}

/** accepted transition 后应用字段 effect（mutate proj）。plan §B 标注的副字段更新。 */
function applyFieldEffects(proj: BallCustodyProjection, event: BallCustodyEvent, now: number): void {
  const p = event.payload;
  switch (event.kind) {
    case 'ball.handed':
      if (typeof p.toCatId === 'string') proj.holder = p.toCatId;
      break;
    case 'ball.handed_cvo':
      if (typeof p.intent === 'string' && VALID_INTENTS.includes(p.intent as BallIntent)) {
        proj.intent = p.intent as BallIntent;
      }
      if (proj.state === 'parked') proj.holder = 'cvo';
      break;
    case 'ball.held':
      if (typeof p.catId === 'string') proj.holder = p.catId;
      if (typeof p.fireAt === 'number') proj.heldUntil = p.fireAt;
      break;
    case 'task.blocked':
      // 新 blocked episode：blockedSinceAt 记 episode identity，清 lastWakeAt（去重锚重置）
      proj.blockedSinceAt = now;
      proj.lastWakeAt = null;
      break;
    case 'ball.wake_sent':
      // best-effort 唤醒已发的记录（仅 blocked 接受，见 transition）
      proj.lastWakeAt = now;
      break;
    case 'invocation.died':
      proj.lastScanAt = typeof p.lastScanAt === 'number' ? p.lastScanAt : now;
      break;
    default:
      break;
  }
}

/**
 * 清 stale transient state fields（cloud review P2 + failure-mode audit）。每个 transient field
 * 只属于特定 state，球离开该 state 旧值就 stale，必须清，否则后续判定误用 stale 值：
 *   - heldUntil 绑 active(held)：换 holder（ball.handed）或离开 active 清（否则 hold_expired 误判已转走的球 dead）
 *   - blockedSinceAt/lastWakeAt 绑 blocked episode：离开 blocked 清（否则跨 episode 污染唤醒去重/晾龄）
 *   - intent 绑 parked(cvo)：离开 parked 清（否则球转回猫后残留 operator intent）
 * 进入态的 setter 在 applyFieldEffects（task.blocked 设 blockedSinceAt+清 lastWakeAt、ball.held 设
 * heldUntil 等），与本函数「离开清」互补：setter 后 state 仍在归属态，不会被清。
 */
function clearStaleTransientFields(proj: BallCustodyProjection, event: BallCustodyEvent): void {
  if (event.kind === 'ball.handed' || proj.state !== 'active') {
    proj.heldUntil = null;
  }
  if (proj.state !== 'blocked') {
    proj.blockedSinceAt = null;
    proj.lastWakeAt = null;
  }
  if (proj.state !== 'parked') {
    proj.intent = null;
  }
}

export class BallCustodyProjector {
  constructor(
    private readonly eventLog: IBallCustodyEventLog,
    private readonly store: IBallCustodyProjectionStore,
  ) {}

  /** 应用单事件到 projection。事件须已在 event log（append first）。 */
  async apply(event: BallCustodyEvent): Promise<void> {
    const now = event.at;
    const existing = await this.store.get(event.subjectKey);
    const proj = existing ?? createInitialProjection(event.subjectKey, now);

    const result = transition(proj.state, event, {
      heldUntil: proj.heldUntil,
      lastStateChangeAt: proj.lastStateChangeAt,
    });

    if (!result.ok) {
      // rejected：不改 state。state-changing 记 lastRejectedEvent（observability）；
      // informational（ball.wake_sent 非 blocked）不记（不污染）。
      const rejected: BallCustodyProjection = {
        ...proj,
        lastEventAt: now,
        updatedAt: now,
        lastRejectedEvent: event.classification === 'state-changing' ? event : proj.lastRejectedEvent,
      };
      await this.store.save(rejected);
      return;
    }

    const stateChanged = result.next !== proj.state;
    const updated: BallCustodyProjection = {
      ...proj,
      state: result.next,
      appliedEventCount: proj.appliedEventCount + 1,
      lastRejectedEvent: null,
      lastEventAt: now,
      updatedAt: now,
      lastStateChangeAt: stateChanged ? now : proj.lastStateChangeAt,
    };
    applyFieldEffects(updated, event, now);
    clearStaleTransientFields(updated, event);
    await this.store.save(updated);
  }

  /** 重建单 subject projection：删除现有 → replay 全部事件（INV-2）。 */
  async rebuild(subjectKey: string): Promise<void> {
    await this.store.delete(subjectKey);
    const events = await this.eventLog.read(subjectKey);
    for (const event of events) {
      await this.apply(event);
    }
  }

  /** 重建所有 subject projection。 */
  async rebuildAll(): Promise<void> {
    const subjects = await this.eventLog.listSubjects();
    for (const subjectKey of subjects) {
      await this.rebuild(subjectKey);
    }
  }
}
