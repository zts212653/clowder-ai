/**
 * F297 Phase B — Sidebar C10 presence 投影（route 层 read-model）。
 *
 * 从 `threads.ts` 抽出（cloud R9 P1）：那个路由基线已 1392 行，本 PR 又往里加了一个
 * **独立的 read-model 职责**。路由应只做 orchestration，呈现投影归这里。
 *
 * 边界：本模块**不含任何 liveness 规则**。谁在跑由 dispatch owner 的
 * `SidebarPresenceSource` 回答（内部是 F194/F295 的 composition），这里只负责
 * “working 优先、终态只在待用户注意时可见”的呈现合成。
 */

import type { Thread } from '../domains/cats/services/stores/ports/ThreadStore.js';

type SidebarThreadProjectionInput = Thread & {
  readonly unreadCount?: number;
  readonly hasUserMention?: boolean;
};

/**
 * F297 C10: presentation-ready Sidebar presence.
 *
 * 这是 Sidebar 行状态的**唯一**呈现真相。raw `activeInvocations` / `catInvocations`
 * 一律不进 DTO —— 一旦泄给 render 层，浏览器就重新获得再仲裁能力（AC-C7 同源风险）。
 */
export interface SidebarPresence {
  readonly status: 'idle' | 'working' | 'done' | 'error';
  readonly cats?: readonly string[];
  /** C10 execution elapsed authority; C7 lastActiveAt remains recency-only. */
  readonly activeSince?: number;
}

/**
 * F297 OQ-1: presence 必须**一次批量**解析，且只对 active candidate 稀疏对账。
 * 具体的候选集来源（running InvocationRecord / Tracker slot / child execution /
 * managed command 的可重建二级索引）由 `dispatch` owner 的 composition service 提供；
 * 本路由只 join 结果，不复制 F194/F295 的生命周期规则。
 */
export interface SidebarPresenceSource {
  getPresence(threadIds: readonly string[], userId: string): Promise<Map<string, SidebarPresence>>;
}

/**
 * F297 C10: working 总是可见；done/error 只表示“有新终态待看”。
 *
 * InvocationRecord 回答“真的结束了吗”；unread/mention 回答“用户还需要看吗”。
 * 用户进入 thread 并读取后，终态标记消失，但持久 lifecycle 证据仍保留。
 */
export async function composeSidebarPresence(
  threads: readonly SidebarThreadProjectionInput[],
  userId: string,
  presenceSource: SidebarPresenceSource | undefined,
): Promise<Map<string, SidebarPresence>> {
  const composed = new Map<string, SidebarPresence>();
  let authoritative = new Map<string, SidebarPresence>();
  try {
    authoritative = presenceSource
      ? await presenceSource.getPresence(
          threads.map((thread) => thread.id),
          userId,
        )
      : authoritative;
  } catch {
    // 生命周期读故障不能 500 整个 Sidebar，也不能推断终态。
  }

  for (const thread of threads) {
    const presence = authoritative.get(thread.id) ?? { status: 'idle' as const };
    if (presence.status === 'working') {
      composed.set(thread.id, presence);
      continue;
    }
    const needsAttention = (thread.unreadCount ?? 0) > 0 || thread.hasUserMention === true;
    composed.set(thread.id, needsAttention ? presence : { status: 'idle' });
  }
  return composed;
}
