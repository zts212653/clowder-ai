/**
 * F233 Phase C C2b step 2 part 4 — `RealThreadSearch` 真实 thread store adapter
 *
 * 替换 C2a 的 mock `ThreadSearch` interface 用 thread store 查询找 featId 关联 threads.
 *
 * Discovery 方法（按优先级）：
 * 1. Thread labels 含 `feat:F###` 或 `F###` — 显式 link，high confidence
 * 2. Thread title 含 `F###` token — 命名约定 (e.g., "F233 Phase C 收口")
 *
 * 当前实现做 confirmation 而非 discovery（C2a 已 documented + cloud round 3 P2
 * 移除 thread_keyword from FeatThreadJoinMethod）。本 adapter 找 threads 给
 * `lastMessageAt` / `lastActivityAt` 时间戳（F188 提包球 invariant 用：
 * `lastThreadMessageAt < headCommitAt` 证明"猫提着包走完一棒没回头"）。
 *
 * 设计：
 * - `adapter` 注入式 — 生产 wrap IThreadStore.list(userId); tests stub canned data
 * - 优雅降级：adapter 抛错 → 返空 (heuristic join 仍能跑)
 * - 不做 caching — thread 状态变化频繁，每次 cron tick 重新查
 *
 * plan: docs/plans/2026-06-18-f233-phase-c-euthanasia-trajectory.md §C2b
 */

import type { ThreadMatch, ThreadSearch } from './GitRefSnapshotCollector.js';

/** 抽象 thread 查询 — 生产 wraps IThreadStore, tests stub. */
export interface ThreadSearchAdapter {
  /**
   * Return all threads visible to the collector context (typically owner's
   * threads — cron task runs as system / default user).
   *
   * Each entry must include: threadId / title / lastMessageAt (Unix ms) /
   * lastActivityAt (Unix ms) / optional labels[].
   */
  listAll(): Promise<
    Array<{
      threadId: string;
      title: string;
      lastMessageAt: number | null;
      lastActivityAt: number | null;
      labels?: string[];
    }>
  >;
}

export class RealThreadSearch implements ThreadSearch {
  constructor(private readonly adapter: ThreadSearchAdapter) {}

  async findByFeatId(featId: string): Promise<ThreadMatch[]> {
    if (!featId) return [];
    if (!/^F\d{2,4}$/i.test(featId)) return []; // sanity check

    let all: Awaited<ReturnType<ThreadSearchAdapter['listAll']>>;
    try {
      all = await this.adapter.listAll();
    } catch (_e) {
      // 优雅降级：thread store 不可用 → 返空 (heuristic 不依赖 thread)
      return [];
    }

    // Match by:
    // 1. exact `feat:F###` label
    // 2. `F###` token in labels
    // 3. `F###` token in title (case-insensitive whole-word match)
    const featIdUpper = featId.toUpperCase();
    const featPattern = new RegExp(`\\b${featIdUpper}\\b`, 'i');
    const matches: ThreadMatch[] = [];
    const seen = new Set<string>();

    for (const t of all) {
      if (seen.has(t.threadId)) continue;
      const labels = t.labels ?? [];
      const exactLabelMatch = labels.some((l) => l === `feat:${featIdUpper}` || l.toUpperCase() === featIdUpper);
      const tokenLabelMatch = labels.some((l) => featPattern.test(l));
      const titleMatch = featPattern.test(t.title);

      if (exactLabelMatch || tokenLabelMatch || titleMatch) {
        seen.add(t.threadId);
        matches.push({
          threadId: t.threadId,
          lastMessageAt: t.lastMessageAt,
          lastActivityAt: t.lastActivityAt,
        });
      }
    }

    return matches;
  }
}
