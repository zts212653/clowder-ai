/**
 * F297 Phase B — Sidebar C10 presence 投影（route 层 read-model）。
 *
 * 从 `threads.ts` 抽出（cloud R9 P1）：那个路由基线已 1392 行，本 PR 又往里加了一个
 * **独立的 read-model 职责**。路由应只做 orchestration，呈现投影归这里。
 *
 * 边界：本模块**不含任何 liveness 规则**。谁在跑由 dispatch owner 的
 * `SidebarPresenceSource` 回答（内部是 F194/F295 的 composition），这里只负责
 * “active 优先、否则回落终态”的呈现合成。
 */

import type {
  IThreadStore,
  Thread,
  ThreadParticipantActivity,
} from '../domains/cats/services/stores/ports/ThreadStore.js';

/**
 * F297 C10: presentation-ready Sidebar presence.
 *
 * 这是 Sidebar 行状态的**唯一**呈现真相。raw `activeInvocations` / `catInvocations`
 * 一律不进 DTO —— 一旦泄给 render 层，浏览器就重新获得再仲裁能力（AC-C7 同源风险）。
 */
export interface SidebarPresence {
  readonly status: 'idle' | 'working' | 'done' | 'error';
  readonly cats?: readonly string[];
}

/**
 * F297 OQ-1: presence 必须**一次批量**解析，且只对 active candidate 稀疏对账。
 * 具体的候选集来源（running InvocationRecord / Tracker slot / child execution /
 * managed command 的可重建二级索引）由 `dispatch` owner 的 composition service 提供；
 * 本路由只 join 结果，不复制 F194/F295 的生命周期规则。
 */
export interface SidebarPresenceSource {
  getActivePresence(threadIds: readonly string[], userId: string): Promise<Map<string, SidebarPresence>>;
}

/**
 * F297 C10 fallback：active execution 缺席时的终态呈现。
 *
 * 铁律（Design Gate 决议）：**active 消失本身不是 done 的证据**。done / error 只能来自
 * participant activity 的正向终态记录；没有任何猫回过话 → idle，绝不 done。
 * 取"最近一次回应"的健康度，对应 doc 里的"最近 done/error"，而不是"历史上出过错就永远 error"。
 */
export function terminalPresenceFromActivity(activity: readonly ThreadParticipantActivity[]): SidebarPresence {
  const responded = activity.filter((entry) => entry.lastMessageAt > 0);
  if (responded.length === 0) return { status: 'idle' };
  // getParticipantsWithActivity 已按 lastMessageAt 降序排序
  const latest = responded[0];
  if (latest.lastResponseHealthy === false) return { status: 'error', cats: [latest.catId] };
  return { status: 'done', cats: [latest.catId] };
}

/** F297 Phase B: 组合 C10 presence —— active 优先，否则回落到 participant activity 终态。 */
export async function composeSidebarPresence(
  threads: readonly Thread[],
  userId: string,
  threadStore: IThreadStore,
  presenceSource: SidebarPresenceSource | undefined,
): Promise<Map<string, SidebarPresence>> {
  const composed = new Map<string, SidebarPresence>();
  // OQ-1：一次批量调用，不 per-thread round trip
  const active = presenceSource
    ? await presenceSource.getActivePresence(
        threads.map((t) => t.id),
        userId,
      )
    : new Map<string, SidebarPresence>();

  // AC-B3：只对没有 active 的行查终态，且一次批量（Redis 侧走 pipeline，非 per-thread 往返）
  const terminalNeeded = threads.filter((thread) => !active.has(thread.id)).map((thread) => thread.id);
  // 终态回落的读故障必须**显式** fail-closed：知识不完整时封 idle，而不是 500 掉整个
  // Sidebar 请求，也不是让 store 静默返回空 hash 冒充"没人回过话"（R10 / cloud R11 P1）。
  let activityByThread: Map<string, ThreadParticipantActivity[]>;
  try {
    activityByThread =
      terminalNeeded.length > 0
        ? await threadStore.getParticipantsWithActivityBatch(terminalNeeded)
        : new Map<string, ThreadParticipantActivity[]>();
  } catch {
    activityByThread = new Map<string, ThreadParticipantActivity[]>();
  }

  for (const thread of threads) {
    const live = active.get(thread.id);
    composed.set(thread.id, live ?? terminalPresenceFromActivity(activityByThread.get(thread.id) ?? []));
  }
  return composed;
}
