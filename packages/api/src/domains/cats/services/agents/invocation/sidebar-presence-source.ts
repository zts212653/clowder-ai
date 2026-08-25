/**
 * F297 Phase B — dispatch-owned Sidebar presence adapter.
 *
 * 职责边界（Design Gate + PR #3748 review 决议）：
 * - **候选发现**：取 `ActiveExecutionService.listCandidateThreadIds` 的三源 union（tracker slot /
 *   running record / managed command / running child），与请求集合求交，把工作量压到 O(A) 而非 O(T)。
 * - **定性**：交给 `ActiveExecutionService.resolveWorkingPresence`。本模块**不复制**任何 liveness
 *   规则，不读 record/draft/turn-execution/task store，因此不构成第二份 classifier。
 * - **终态证据**：只读 InvocationRecord 的最新 terminal pointer；participant activity
 *   与 session-open 状态都不是完成证据。
 * - **翻译**：把 lifecycle 结果翻成 Sidebar 的 presentation-ready C10。
 *
 * R3 P1-1/P1-2 的教训写在这里：定性通道以前只有 live-invocation classifier 一条，
 * managed command 与 standalone running child 提名得进候选、却没人能给它们定性，
 * 于是 presence=null → 调用方终态回落 → working 被显示成 done/error。现在定性走
 * "谁提名谁定性"的正向投影，候选源与定性源一一对应。
 *
 * 归属：`dispatch` / Chat runtime。`thread-navigation` 只消费本模块的输出。
 */

export interface SidebarPresenceValue {
  readonly status: 'idle' | 'working' | 'done' | 'error';
  readonly cats?: readonly string[];
  readonly activeSince?: number;
}

/** 一次请求的 owner-truth 物化视图（domain 侧 `ActiveExecutionSnapshot` 的结构性契约）。 */
export interface SidebarActiveExecutionSnapshot {
  readonly threadIds: readonly string[];
  readonly complete: boolean;
}

export interface SidebarTerminalExecution {
  readonly status: 'succeeded' | 'failed' | 'canceled';
  readonly successfulCatIds?: readonly string[];
}

export interface SidebarPresenceSourceDeps<TSnapshot extends SidebarActiveExecutionSnapshot> {
  /**
   * **每请求一次**：四源候选 union（tracker slot / running record / running managed command /
   * running child）+ owner-truth 物化。`complete=false` 表示至少一源不可用，union 可能漏报。
   *
   * R4 P1-1：owner-truth 两张脸是 user-scoped 全局枚举，成本与 candidate 数无关，
   * 所以只能读一次。逐 candidate 去重读会让 A 个候选形成 1+A 次全局枚举（最坏 O(A²)）。
   */
  buildSnapshot(userId: string): Promise<TSnapshot>;
  /**
   * 正向 working 定性：owner-truth 从 snapshot 查表，只有 live classifier 按 thread 提问。
   * `complete=false` 表示至少一面定性失败 —— 此时**不得**推断该 thread 空闲或终态。
   */
  resolveWorkingPresence(
    threadId: string,
    userId: string,
    snapshot: TSnapshot,
  ): Promise<{ readonly catIds: readonly string[]; readonly activeSince?: number; readonly complete: boolean }>;
  /** Batch lifecycle witness; absent means no indexed terminal evidence, never "infer done". */
  listLatestTerminalExecutions(
    threadIds: readonly string[],
    userId: string,
  ): Promise<Map<string, SidebarTerminalExecution>> | Map<string, SidebarTerminalExecution>;
}

export function createSidebarPresenceSource<TSnapshot extends SidebarActiveExecutionSnapshot>(
  deps: SidebarPresenceSourceDeps<TSnapshot>,
): {
  getPresence(threadIds: readonly string[], userId: string): Promise<Map<string, SidebarPresenceValue>>;
} {
  return {
    async getPresence(threadIds, userId) {
      const presence = new Map<string, SidebarPresenceValue>();
      if (threadIds.length === 0) return presence;

      const requested = new Set(threadIds);
      // 每请求一次：候选发现 + owner truth 都在这一次读里。
      // 整体失败 = 对"谁在跑"零知识。fail-closed：全部标 idle，调用方进不了终态投影，
      // 绝不可能把 working 谎报成 done/error。
      const discovery = await deps.buildSnapshot(userId).catch(() => null);
      if (!discovery) {
        for (const threadId of threadIds) presence.set(threadId, { status: 'idle' });
        return presence;
      }
      const candidates = discovery.threadIds.filter((threadId) => requested.has(threadId));

      /**
       * R3 P1-3 fail-closed：知识不完整时，"不在 union 里"**不等于**"没在跑"。
       * 显式把其余行标成 idle，调用方就进不了 InvocationRecord 终态投影。
       * 宁可少显示，绝不谎报终态。
       */
      const sealed = new Set<string>();
      const sealAll = (complete: boolean) => {
        if (complete) return;
        for (const threadId of threadIds) {
          if (!presence.has(threadId) && !sealed.has(threadId)) presence.set(threadId, { status: 'idle' });
        }
      };

      if (candidates.length === 0 && !discovery.complete) {
        sealAll(false);
        return presence;
      }

      const classified = await Promise.all(
        candidates.map(async (threadId) => {
          try {
            return { threadId, working: await deps.resolveWorkingPresence(threadId, userId, discovery) };
          } catch {
            // 定性抛错 = 对**这个已被提名的候选** 零知识。它恰恰是最可能真在跑的行，
            // 放它去走终态投影就是 false terminal。按同一条铁律封成 idle。
            return { threadId, working: { catIds: [] as readonly string[], complete: false } };
          }
        }),
      );

      for (const { threadId, working } of classified) {
        if (working.catIds.length > 0) {
          presence.set(threadId, {
            status: 'working',
            cats: [...new Set(working.catIds)],
            ...(working.activeSince !== undefined ? { activeSince: working.activeSince } : {}),
          });
          continue;
        }
        // 定性不完整且没拿到任何 cat：不知道它在不在跑 → 封成 idle，不交给终态投影。
        if (!working.complete) {
          presence.set(threadId, { status: 'idle' });
          sealed.add(threadId);
        }
      }
      sealAll(discovery.complete);
      if (!discovery.complete) return presence;

      const terminalNeeded = threadIds.filter((threadId) => !presence.has(threadId));
      let terminal = new Map<string, SidebarTerminalExecution>();
      if (terminalNeeded.length > 0) {
        try {
          terminal = await deps.listLatestTerminalExecutions(terminalNeeded, userId);
        } catch {
          // Unknown terminal evidence is idle.  It must never fall back to conversation activity.
        }
      }

      for (const threadId of terminalNeeded) {
        const execution = terminal.get(threadId);
        if (execution?.status === 'succeeded' && (execution.successfulCatIds?.length ?? 0) > 0) {
          presence.set(threadId, {
            status: 'done',
            cats: [...new Set(execution.successfulCatIds)],
          });
        } else if (execution?.status === 'failed') {
          presence.set(threadId, { status: 'error' });
        }
      }
      return presence;
    },
  };
}
