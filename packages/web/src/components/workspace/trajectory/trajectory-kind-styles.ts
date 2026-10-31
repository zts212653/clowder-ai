/**
 * F233 Phase C C3 — Trajectory kind → 视觉 token 映射（13 kind 配色集中管理）。
 *
 * 设计来源：`designs/F233-trajectory-timeline-design.md`（烁烁35 暗色霓虹规格）。
 * 配色用项目 `conn-*` 语义 token（purple/emerald/cyan/amber/gray 全套）而非硬编码
 * raw 色——主题适配 + 与 Hub 其它 panel 一致。
 *
 * **Tailwind purge 约束**：class 串必须是字面量（不可动态拼 `conn-${tone}-text`，
 * 否则 production build 被 purge 删掉）。故 TONE_CLASSES 用完整静态字符串。
 */

import type { FeatTrajectoryKind, FeatTrajectorySource } from '@cat-cafe/shared';

export type TrajectoryTone = 'purple' | 'emerald' | 'cyan' | 'amber' | 'gray';

export interface KindVisual {
  tone: TrajectoryTone;
  /** 中文友好名（卡片 badge 显示） */
  label: string;
  /** emoji icon，快速扫描区分 family */
  icon: string;
  family: 'ball' | 'git' | 'historical';
}

/**
 * 13 kind → 视觉。配色遵循设计稿 §1：
 * - 球权事件流（ball）：紫=启动/跃迁/线程，翠绿=合并/裁决/归档，天蓝=重启
 * - git 巡检轨（git）：青=推送/PR/合入，警示橙=滞留未合（提包球）
 * - 历史考古轨（historical）：哑灰虚线
 */
export const KIND_VISUALS: Record<FeatTrajectoryKind, KindVisual> = {
  // ── Ball-shaped（球权事件流，语义在球权事件层）──
  launched: { tone: 'purple', label: '启动', icon: '🚀', family: 'ball' },
  phase_transition: { tone: 'purple', label: 'Phase 跃迁', icon: '🔄', family: 'ball' },
  thread_split: { tone: 'purple', label: '线程分裂', icon: '🪢', family: 'ball' },
  thread_merge: { tone: 'purple', label: '线程合并', icon: '🔗', family: 'ball' },
  pr_merged: { tone: 'emerald', label: 'PR 合并', icon: '✅', family: 'ball' },
  verdict: { tone: 'emerald', label: '裁决', icon: '⚖️', family: 'ball' },
  closed: { tone: 'emerald', label: '归档', icon: '📦', family: 'ball' },
  reopened: { tone: 'cyan', label: '重启', icon: '♻️', family: 'ball' },
  // ── Git-shaped（git 巡检轨，与 ball 显式解耦）──
  branch_pushed: { tone: 'cyan', label: '分支推送', icon: '⬆️', family: 'git' },
  pr_opened: { tone: 'cyan', label: 'PR 开启', icon: '📬', family: 'git' },
  branch_merged_to_main: { tone: 'cyan', label: '合入主干', icon: '🌿', family: 'git' },
  branch_stale_unmerged: { tone: 'amber', label: '滞留未合', icon: '⚠️', family: 'git' },
  // ── Historical（历史考古轨，stitched 拼接产物）──
  historical_stitched: { tone: 'gray', label: '历史考古', icon: '🔍', family: 'historical' },
};

/** 多源标签（卡片右上角徽章 + 时间轴叙事）。 */
export const SOURCE_LABELS: Record<FeatTrajectorySource, string> = {
  'event-stream': 'event-stream',
  'historical-stitched': 'stitched',
  'git-ref-snapshot': 'git-ref',
};

/**
 * tone → 完整静态 Tailwind class（字面量，purge-safe）。
 * - dot：时间轴节点圆圈（实心 + ring 光晕，width 由组件加 `ring-4`）
 * - badge：kind 徽章底/字/边
 * - cardBorder：卡片边框 + hover（amber=提包球额外 neon glow）
 * - line：时间轴连接线色
 */
export const TONE_CLASSES: Record<TrajectoryTone, { dot: string; badge: string; cardBorder: string; line: string }> = {
  purple: {
    dot: 'bg-conn-purple-text ring-conn-purple-text/20',
    badge: 'bg-conn-purple-bg/20 text-conn-purple-text border-conn-purple-ring/40',
    cardBorder: 'border-conn-purple-ring/20 hover:border-conn-purple-ring/50',
    line: 'bg-conn-purple-ring/30',
  },
  emerald: {
    dot: 'bg-conn-emerald-text ring-conn-emerald-text/20',
    badge: 'bg-conn-emerald-bg/20 text-conn-emerald-text border-conn-emerald-ring/40',
    cardBorder: 'border-conn-emerald-ring/20 hover:border-conn-emerald-ring/50',
    line: 'bg-conn-emerald-ring/30',
  },
  cyan: {
    dot: 'bg-conn-cyan-text ring-conn-cyan-text/20',
    badge: 'bg-conn-cyan-bg/20 text-conn-cyan-text border-conn-cyan-ring/40',
    cardBorder: 'border-conn-cyan-ring/20 hover:border-conn-cyan-ring/50',
    line: 'bg-conn-cyan-ring/30',
  },
  amber: {
    // 提包球警示色 + 霓虹 glow（neon glow 固定琥珀色，符合"警示"语义）
    dot: 'bg-conn-amber-text ring-conn-amber-text/30',
    badge: 'bg-conn-amber-bg/20 text-conn-amber-text border-conn-amber-ring/40',
    cardBorder: 'border-conn-amber-ring/50 shadow-[0_0_12px_rgba(245,158,11,0.18)] hover:border-conn-amber-text',
    line: 'bg-conn-amber-ring/40',
  },
  gray: {
    // 历史考古：哑灰虚线 + 半透明降噪
    dot: 'bg-conn-gray-text ring-conn-gray-text/10',
    badge: 'bg-conn-gray-bg/40 text-conn-gray-text border-conn-gray-ring/30',
    cardBorder: 'border-conn-gray-ring/30 border-dashed opacity-75 hover:opacity-100',
    line: 'bg-conn-gray-ring/30',
  },
};

/** 「提包球」判定：滞留未合 + 猫提包离线（last thread message 早于 head commit）。 */
export function isCarryingBag(
  kind: FeatTrajectoryKind,
  lastThreadMessageAt: number | null,
  headCommitAt: number,
): boolean {
  return kind === 'branch_stale_unmerged' && lastThreadMessageAt !== null && lastThreadMessageAt < headCommitAt;
}
