/**
 * F252 Phase C — Feature Story Rendering DTO（BFF → Frontend boundary）
 *
 * Story Player 渲染层的数据契约。BFF 消费 F233 `FeatTrajectoryProjection`
 * 投影出渲染友好的 DTO——泳道布局 + 因果边几何 + 时间轴里程碑。
 *
 * **设计原则**（KD-5）：Story Player 是 Renderer 不是 Builder，
 * 数据层复用 F233 单一真相源，本 DTO 只做坐标映射。
 */

import type { FeatTrajectoryKind, TrajectoryProvenance } from './feat-trajectory.js';

// ============================================================================
// Top-level rendering DTO
// ============================================================================

/**
 * Feature Story 渲染数据包——BFF endpoint 的唯一输出。
 * 前端直接消费，不做二次数据处理。
 */
export interface FeatureStoryRenderingDTO {
  /** `feat:<featId>` */
  storyId: string;
  featId: string;
  /** Feature title, e.g. "F252: Story Player" */
  title: string;
  /** Unix ms — 故事覆盖的时间范围 */
  timeRange: { start: number; end: number };
  /** 泳道（每个 thread 一条） */
  lanes: SwimlaneDTO[];
  /** 跨泳道因果边 */
  edges: CausalEdgeDTO[];
  /** 时间轴全局里程碑（从 trajectory entries 提取的叙事节拍） */
  milestones: TimelineMilestoneDTO[];
}

// ============================================================================
// Swimlane
// ============================================================================

export interface SwimlaneDTO {
  threadId: string;
  threadName: string;
  /** 参与此 thread 的猫 ID 集合（从 entries 的 catId 字段聚合） */
  participants: string[];
  /** 本 lane 内的 trajectory markers（按时间排序） */
  markers: TrajectoryMarkerDTO[];
  /**
   * Guest lane — thread referenced only as a thread_merge target (cross-post
   * destination) and not introduced by thread_split or git-ref-snapshot.
   * Frontend should exclude guest lanes from featureThreadIds so the
   * cross-feature detector still fires for these interactions (AC-E6).
   */
  guest?: boolean;
}

/**
 * 泳道内的单个轨迹标记——对应一条 `FeatTrajectoryEntry`。
 * 前端用 kind + tone 决定图标/颜色/尺寸。
 */
export interface TrajectoryMarkerDTO {
  entryId: string;
  /** Unix ms */
  at: number;
  kind: FeatTrajectoryKind;
  /** 人类友好标签，e.g. "PR #2575 合入主干" */
  label: string;
  /** 前端 drill-down 用：有 sessionId → 可跳 Theater */
  sessionId?: string;
  /** 原始 payload 精简版（前端 tooltip/详情用） */
  details: Record<string, unknown>;
}

// ============================================================================
// Causal Edge（跨泳道因果箭头）
// ============================================================================

/**
 * 因果边——连接两个泳道的可视化箭头。
 *
 * 来源仅限 F233 投影的显式 kinds（KD-4：不做事件层启发式推断）：
 * - `thread_split`: parentThread → childThread（分裂）
 * - `thread_merge`: sourceThread → targetThread（合并/cross-post）
 * - `branch_merged_to_main`: feature branch → main（合入，暂用 git-shaped 替代 ball-shaped `pr_merged`）
 */
export interface CausalEdgeDTO {
  id: string;
  kind: 'thread_split' | 'thread_merge' | 'branch_merged_to_main';
  from: { threadId: string; time: number };
  to: { threadId: string; time: number };
  /** 箭头标注文字 */
  label: string;
  /** 置信度决定箭头样式：high=实线, medium=虚线, low=点线 */
  confidence: 'high' | 'medium' | 'low';
  provenance?: TrajectoryProvenance;
}

// ============================================================================
// Timeline Milestone
// ============================================================================

/**
 * 时间轴全局里程碑——横跨所有泳道的叙事节拍标记。
 * 从 trajectory entries 中提取有全局意义的 kinds。
 */
export interface TimelineMilestoneDTO {
  /** Unix ms */
  at: number;
  kind: FeatTrajectoryKind;
  label: string;
  /** 对应的 entryId（前端点击跳转用） */
  entryId: string;
}
