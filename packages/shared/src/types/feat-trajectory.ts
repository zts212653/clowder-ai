/**
 * F233 Phase C C2a — Feat Trajectory Types（轨迹 read model terminal schema）
 *
 * Trajectory = 球权事件流账本的纵切投影 + git ref snapshot 三源收敛
 * （OQ-8 锁定 + 砚砚 KD-C6 C2a preflight P2-1/P2-2/P2-4/P3 收敛）。
 *
 * 三源 contract：
 * - **事件流轨**（≥ Phase B 上线时刻 2026-06-15）：`BallCustodyEventLog`
 *   投影成 ball-shaped kinds（launched/phase_transition/verdict 等）
 * - **历史回填轨**（< Phase B 上线时刻）：stitched 一次性脚本
 *   （feat_index + git log + thread + F192 verdict），标 provenance + confidence
 * - **git ref 轨**（OQ-8 锁定 + F188 提包球 case 实证驱动）：server-side cron
 *   census `git ls-remote` + GitHub PR API → `GitRefSnapshot` DTO → projector
 *   投影成 git-shaped kinds，**显式与 ball-shaped 命名解耦**（schema 层非球权事件）
 *
 * KD-1：subjectKey 派生（featId 是 F#，git-ref subjectKey 派生 branchName），
 * 不引入新原语。impl 住 `packages/api/src/domains/feat-trajectory/`。
 *
 * plan: docs/plans/2026-06-18-f233-phase-c-euthanasia-trajectory.md §C
 */

// ============================================================================
// 3 source types（OQ-8 三轨 source-contract 锁定）
// ============================================================================

export type FeatTrajectorySource =
  | 'event-stream' // ball-custody event → kind 投影
  | 'historical-stitched' // < Phase B 上线时刻考古拼接（标 provenance）
  | 'git-ref-snapshot'; // OQ-8 锁定，server-side cron census

// ============================================================================
// 13 kinds（OQ-8 ball-shaped vs git-shaped 显式解耦 + 砚砚 P3 rename）
// ============================================================================

/** Ball-custody event 投影出的 trajectory kinds（语义在球权事件层）。 */
export type BallShapedTrajectoryKind =
  | 'launched'
  | 'phase_transition'
  | 'pr_merged'
  | 'verdict'
  | 'thread_split'
  | 'thread_merge'
  | 'closed'
  | 'reopened';

/** 历史回填 kinds（一次性脚本，stitched 拼接产物）。 */
export type HistoricalTrajectoryKind = 'historical_stitched';

/**
 * Git ref snapshot 投影出的 trajectory kinds（git-shaped 命名，与 ball-shaped 显式解耦）。
 * 砚砚 P3：`pr_merged_via_git` → `branch_merged_to_main`（git ref state 非 PR 事件）。
 * `pr_opened` 保留——来源真是 GitHub PR map。
 */
export type GitShapedTrajectoryKind = 'branch_pushed' | 'pr_opened' | 'branch_merged_to_main' | 'branch_stale_unmerged';

export type FeatTrajectoryKind = BallShapedTrajectoryKind | HistoricalTrajectoryKind | GitShapedTrajectoryKind;

// ============================================================================
// Stale bucket（砚砚 P2-4：bucket 进 entry id，叙事完整支撑"怎么拖到今天"）
// ============================================================================

/**
 * Stale unmerged branch 的 age bucket。Collector 按 `ageMs = now - headCommitAt`
 * 分配 first-crossed bucket。同 bucket 内多 tick → upsert 同 entry id；
 * 跨阈值 → 新 segment → 新 entry id → 新独立轨迹点（F188 case 最多 4 个）。
 */
export type StaleBucket = '24h' | '72h' | '7d' | '30d';

// ============================================================================
// Trajectory provenance + 置信度（历史 stitched 必带；git-ref join 见单独类型）
// ============================================================================

export interface TrajectoryProvenance {
  confidence: 'high' | 'medium' | 'low';
  /** 数据派生来源 hints, e.g. ['feat_index', 'git_log', 'thread:thread_xxx', 'gh_pr:#NNNN', 'git_ref:fix/f188-phase-k'] */
  derivedFrom: string[];
  note?: string;
}

// ============================================================================
// Feat/thread join provenance（砚砚 P2-1：F188 fixture 必须证明
// "是 F188 的提包球"，不只是"有 stale branch"）
// ============================================================================

/**
 * Heuristic join method —— branch ↔ feat 的关联发现路径（discovery methods only）。
 *
 * **Cloud round 3 P2 fix (PR #2439)**：原先有第四个值 `'thread_keyword'`，但实现
 * 上 collector 的 thread search 依赖 already-known `featId`（findByFeatId），
 * 不是真正的 discovery。当前 thread search 只做 post-discovery 关联（拿 last
 * activity 时间戳给 F188 invariant 用）。`thread_keyword` 作为 discovery method
 * 暂未实现（需要新 IO 如 `ThreadSearch.findByBranchKeyword`），超出 C2a scope。
 * 为了避免类型 advertise 不存在的能力，移除 `'thread_keyword'` 值；future 真正
 * 实现 thread-keyword discovery 时再 add back（小 breaking change，比保留 misleading
 * 值更诚实）。
 */
export type FeatThreadJoinMethod =
  | 'feat_index' // 通过 feat_index 表显式注册
  | 'commit_message_F#' // commit message 含 F# pattern
  | 'branch_name_F#'; // branch name 含 F# pattern, e.g. fix/f188-*

export interface FeatThreadJoinProvenance {
  confidence: 'high' | 'medium' | 'low';
  /** Multi-method join 全部记录（同条 branch 可能命中多种 heuristic，confidence 综合反映） */
  joinedVia: FeatThreadJoinMethod[];
}

// ============================================================================
// Git ref snapshot DTO（collector → projector boundary）
// 砚砚 P2-1：git 层最少字段 + feat/thread join 字段 完整
// 砚砚 P2-2：collector 拥有所有 git/gh IO，projector 纯函数消费此 DTO
// ============================================================================

/**
 * `GitRefSnapshotCollector` 产出的 immutable snapshot，喂 `FeatTrajectoryProjector`。
 * Projector 不做 git/gh IO（rebuild=replay 安全 / 纯函数 / 零外部副作用）。
 */
export interface GitRefSnapshot {
  // ── git 层最少字段（OQ-8 source-contract 锁定）────────────────────
  branchName: string;
  headCommitSha: string;
  /** Unix ms */
  headCommitAt: number;
  prNumber: number | null;
  prState: 'open' | 'closed' | 'merged' | null;
  /** PR 状态可能为 closed but never merged（operator closed/discarded） */
  mergedToMain: boolean | null;
  /**
   * 真实 PR opened time (Unix ms)，由 collector 从 GitHub PR API 获取（`created_at`
   * 字段）。砚砚 step 4 护栏：projector emit `pr_opened` entry 时 `entry.at` 必须
   * 用此真实时间，**不能**伪装 `collectedAt` 为真实 PR opened time。
   * null = 无 PR / API 失败 / 未关联 — projector 不 emit `pr_opened` entry（避免污染轨迹）。
   */
  prOpenedAt: number | null;
  /**
   * 真实 PR merged time (Unix ms)，由 collector 从 GitHub PR API 获取（`merged_at`
   * 字段）。同 `prOpenedAt`：`branch_merged_to_main` entry 的 `entry.at` 必须用此
   * 真实时间，null 时 projector 不 emit `branch_merged_to_main` entry。
   */
  prMergedAt: number | null;
  /** Author identity, e.g. 'opus-47' / 'you' (collector 派生于 commit/PR author) */
  authorIdentity: string;

  // ── feat/thread join 字段（砚砚 P2-1：F188 fixture 必须）─────────
  /**
   * Multi-candidate due to heuristic join. 实务上经常单 candidate，但 branch_name
   * 含多 F# 或 commit_message 跨 feat 时可能多个；confidence 综合反映 join 强度。
   */
  featureCandidates: string[];
  associatedThreadIds: string[];
  /**
   * 最后 thread message 时间——F188 fixture 核心 invariant：
   * `lastThreadMessageAt < headCommitAt` 证明"猫提着包走完一棒没回头"。
   * null 表示 join 失败或 thread 无 message。
   */
  lastThreadMessageAt: number | null;
  /** 最后 thread activity 时间（含非 message 活动，e.g. invocation died）。 */
  lastThreadActivityAt: number | null;
  joinProvenance: FeatThreadJoinProvenance;

  // ── collector tick context（用于 staleBucket 分配）────────────────
  /** Unix ms —— collector tick 时间，projector 用此 + headCommitAt 算 ageMs。 */
  collectedAt: number;
}

// ============================================================================
// gitRefEntryId per-kind 公式（cloud P2 fix：id stable per event kind，
// 避免 volatile fields 让同一事件被反复 emit）
//
// **关键不变量**（cloud P2 review: PR #2439, FeatTrajectoryProjector.ts:124）：
// 同一物理事件 → 同一 entry id（upsert 路径），不受周围 state 变化重复创建。
//
// 每 kind id depends on its event identity, not surrounding volatile state:
// - `branch_pushed`: event identity = (branchName, headCommitSha)
//   → 公式: `git-ref:{branchName}:{headCommitSha}:branch_pushed`
//   → PR open/merge state 变化时同 head 不产生新 branch_pushed entry（同 push event）
// - `pr_opened`: event identity = (branchName, prNumber)
//   → 公式: `git-ref:{branchName}:pr-{prNumber}:pr_opened`
//   → 新 commit push 后同 PR 不产生新 pr_opened entry（PR 创建事件只发生一次）
// - `branch_merged_to_main`: event identity = (branchName, prNumber)
//   → 公式: `git-ref:{branchName}:pr-{prNumber}:branch_merged_to_main`
//   → 同 PR merge 事件只一次
// - `branch_stale_unmerged`: event identity = (branchName, headCommitSha, staleBucket)
//   → 公式: `git-ref:{branchName}:{headCommitSha}:branch_stale_unmerged:{staleBucket}`
//   → 同 head 同 bucket 多次 cron tick 同 id（upsert），跨 bucket 阈值新 segment（新 id）
//
// 改公式 = breaking change（影响 store 已有 entries），需走 migration plan。
// ============================================================================

/** Discriminated union — per-kind id derivation (cloud P2 fix). */
export type GitRefEntryIdParts =
  | { kind: 'branch_pushed'; branchName: string; headCommitSha: string }
  | { kind: 'pr_opened'; branchName: string; prNumber: number }
  | { kind: 'branch_merged_to_main'; branchName: string; prNumber: number }
  | {
      kind: 'branch_stale_unmerged';
      branchName: string;
      headCommitSha: string;
      staleBucket: StaleBucket;
    };

/**
 * Pure formula stringifier —— `gitRefEntryId` 派生（cloud P2: per-kind stable id）。
 *
 * Collector 用此构造 upsert key；projector 用此校验 entry id 一致性（rebuild 安全）；
 * tests 用此模拟 cron tick state transitions。
 */
export function makeGitRefEntryId(parts: GitRefEntryIdParts): string {
  switch (parts.kind) {
    case 'branch_pushed':
      return `git-ref:${parts.branchName}:${parts.headCommitSha}:branch_pushed`;
    case 'pr_opened':
      return `git-ref:${parts.branchName}:pr-${parts.prNumber}:pr_opened`;
    case 'branch_merged_to_main':
      return `git-ref:${parts.branchName}:pr-${parts.prNumber}:branch_merged_to_main`;
    case 'branch_stale_unmerged':
      return `git-ref:${parts.branchName}:${parts.headCommitSha}:branch_stale_unmerged:${parts.staleBucket}`;
  }
}

// ============================================================================
// FeatTrajectoryEntry —— terminal schema（照 BallCustodyEvent 模式）
// ============================================================================

export interface FeatTrajectoryEntry {
  /**
   * 幂等 / upsert 键。三源各自规范：
   * - event-stream: `evt:{ballCustodyEvent.sourceEventId}` (trace-back AC-C3)
   * - historical-stitched: `stitch:{featId}:{at}:{stitchType}` (一次性脚本产物)
   * - git-ref-snapshot: makeGitRefEntryId(parts) 公式
   */
  entryId: string;
  /**
   * subjectKey 派生（KD-1 不引球 ID 新原语）：
   * - feat 维度：`feat:{featId}`
   * - branch 维度（git-ref source）：`git-ref:{branchName}`
   */
  subjectKey: string;
  /** F# */
  featId: string;
  /** Unix ms */
  at: number;
  kind: FeatTrajectoryKind;
  source: FeatTrajectorySource;
  /** historical-stitched 必带；git-ref-snapshot 用 join provenance 走 payload */
  provenance?: TrajectoryProvenance;
  /**
   * Source-specific payload。Collector / projector 各自填具体字段：
   * - event-stream: { ballCustodyEvent: BallCustodyEvent }
   * - historical-stitched: { stitchType, fields... }
   * - git-ref-snapshot: { snapshot: GitRefSnapshot, joinProvenance: FeatThreadJoinProvenance }
   */
  payload: Record<string, unknown>;
}

// ============================================================================
// FeatTrajectoryProjection —— per-feat aggregate（rebuildable read model）
// 照 BallCustodyProjection: rebuild=replay 后逐字段相同（INV-2）
// ============================================================================

export interface FeatTrajectoryProjection {
  featId: string;
  /** 按时间升序 (rebuild 后字段相同 invariant) */
  entries: FeatTrajectoryEntry[];
  /** 各源 entries 计数（observability + 单账本验证 AC-C3 用） */
  countsBySource: Record<FeatTrajectorySource, number>;
  /** 各 kind entries 计数（Partial 因 kind 多但 projection 不一定全部出现） */
  countsByKind: Partial<Record<FeatTrajectoryKind, number>>;
  /** projector rebuild 一致性校验 (INV-2) */
  appliedEntryCount: number;
  /** Unix ms */
  createdAt: number;
  updatedAt: number;
}
