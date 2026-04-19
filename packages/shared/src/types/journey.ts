/**
 * F160 Cat Journey (猫猫足迹) — shared types
 * Activity footprint visualization: trait portrait + footfall + moments
 *
 * Naming pivot (ADR-023): "Growth" → "Journey"
 * - XP → 足迹点 / Footfall
 * - Level → 历练 / Seasoning
 * - Achievement → 珍贵瞬间 / Moments
 * - Radar chart → 特质画像 / Traits Portrait
 */

import type { CatId } from './ids.js';

// ── Trait Dimensions (六维特质) ─────────────────────────────────────

/** The six trait dimensions (formerly GrowthDimension) */
export type TraitDimension = 'architecture' | 'review' | 'aesthetics' | 'execution' | 'collaboration' | 'insight';

export const TRAIT_DIMENSIONS: readonly TraitDimension[] = [
  'architecture',
  'review',
  'aesthetics',
  'execution',
  'collaboration',
  'insight',
] as const;

/** Human-readable labels for each trait dimension */
export const DIMENSION_LABELS: Record<TraitDimension, { zh: string; en: string }> = {
  architecture: { zh: '架构力', en: 'Architecture' },
  review: { zh: '审查力', en: 'Review' },
  aesthetics: { zh: '审美力', en: 'Aesthetics' },
  execution: { zh: '执行力', en: 'Execution' },
  collaboration: { zh: '协作力', en: 'Collaboration' },
  insight: { zh: '洞察力', en: 'Insight' },
};

/** Footfall and seasoning for a single trait dimension */
export interface DimensionStat {
  readonly dimension: TraitDimension;
  /** Accumulated footfall (足迹点) */
  readonly xp: number;
  /** Seasoning tier (历练) */
  readonly level: number;
  /** Footfall needed to reach next seasoning tier */
  readonly xpToNext: number;
}

/** Six-dimensional trait snapshot for one cat */
export interface CatAttributes {
  readonly catId: string;
  readonly stats: Record<TraitDimension, DimensionStat>;
  /** Overall seasoning tier (avg of dimension tiers, floored) */
  readonly overallLevel: number;
  /** Total footfall across all dimensions */
  readonly totalXp: number;
  readonly updatedAt: number;
}

/** Currently active title */
export interface CatTitle {
  readonly id: string;
  readonly label: { zh: string; en: string };
  readonly unlockedAt: number;
}

/** Highlight moment linked to a real session */
export interface HighlightMoment {
  readonly label: string;
  readonly sessionId?: string;
  readonly threadId?: string;
  readonly timestamp: number;
}

/** Full journey profile for the cat profile card */
export interface CatJourneyProfile {
  readonly catId: string;
  readonly displayName: string;
  readonly nickname?: string;
  readonly attributes: CatAttributes;
  readonly currentTitle?: CatTitle;
  readonly highlights: readonly HighlightMoment[];
}

/** Team overview for the journey hub page */
export interface JourneyOverview {
  readonly profiles: readonly CatJourneyProfile[];
  readonly teamLevel: number;
  readonly teamTotalXp: number;
  readonly fetchedAt: string;
}

// ── Phase E: Evolution Events (AC-E1) ─────────────────────────────

/** Types of evolution milestones that generate narrative events */
export type EvolutionEventType =
  | 'level_up' // Dimension or overall level increased
  | 'first_dim' // First XP earned in a dimension
  | 'achievement_unlocked' // Achievement/moment unlocked
  | 'title_unlocked' // Title unlocked
  | 'bond_milestone'; // Bond level increased

/** Recorded narrative event for the growth timeline */
export interface EvolutionEvent {
  readonly type: EvolutionEventType;
  readonly catId: string;
  readonly narrative: { readonly zh: string; readonly en: string };
  readonly details: Record<string, unknown>;
  readonly timestamp: number;
}

/** Granular footfall event for audit trail */
export interface FootfallEvent {
  readonly catId: string;
  readonly dimension: TraitDimension;
  readonly xp: number;
  readonly source: FootfallSource;
  readonly detail?: string;
  readonly timestamp: number;
}

export type FootfallSource =
  | 'task_complete'
  | 'session_seal'
  | 'review_given'
  | 'review_received'
  | 'tool_use'
  | 'tool_use_mcp'
  | 'tool_use_skill'
  | 'mention_collab'
  | 'deep_collab'
  | 'discussion'
  | 'pr_merged'
  | 'bug_caught'
  | 'design_feedback'
  | 'rich_block_create'
  | 'evidence_cite'
  | 'cache_efficiency' // Phase E: bonus for high cache hit ratio
  | 'ideate_discussion' // Phase E: ideate intent → architecture bonus
  | 'error_recovery' // Phase E: retry succeeded after failure
  | 'fast_execution'; // Phase E: invocation completed quickly

// ── Titles ────────────────────────────────────────────────────────

/** Condition for unlocking a title */
export type TitleCondition =
  | { readonly type: 'dimension_level'; readonly dimension: TraitDimension; readonly minLevel: number }
  | { readonly type: 'overall_level'; readonly minLevel: number }
  | { readonly type: 'total_xp'; readonly minXp: number };

export type TitleRarity = 'common' | 'rare' | 'epic' | 'legendary';

export interface TitleDefinition {
  readonly id: string;
  readonly label: { readonly zh: string; readonly en: string };
  readonly description: { readonly zh: string; readonly en: string };
  readonly rarity: TitleRarity;
  readonly conditions: readonly TitleCondition[];
}

export interface UnlockedTitle {
  readonly titleId: string;
  readonly catId: string;
  readonly unlockedAt: number;
}

// ── Bonds ─────────────────────────────────────────────────────────

export interface CatBond {
  readonly catA: string;
  readonly catB: string;
  readonly score: number;
  readonly interactions: number;
  readonly lastInteractionAt: number;
}

export type BondLevel = 'acquaintance' | 'partner' | 'soulmate';

// ── Invocation Purpose ────────────────────────────────────────────

export type InvocationPurpose = 'discussion' | 'review';

// ── Moments (珍贵瞬间, formerly Achievements) ─────────────────────

export type MomentCategory = 'individual' | 'team' | 'milestone' | 'hidden';

export type MomentRarity = 'common' | 'rare' | 'epic' | 'legendary';

export type MomentCondition =
  | { readonly type: 'total_xp'; readonly minXp: number }
  | { readonly type: 'overall_level'; readonly minLevel: number }
  | { readonly type: 'dimension_level'; readonly dimension: TraitDimension; readonly minLevel: number }
  | { readonly type: 'title_count'; readonly minCount: number }
  | { readonly type: 'bond_count'; readonly minCount: number }
  | { readonly type: 'bond_level'; readonly minLevel: BondLevel }
  | { readonly type: 'task_count'; readonly minCount: number }
  | { readonly type: 'review_count'; readonly minCount: number }
  | { readonly type: 'session_count'; readonly minCount: number };

export interface MomentDefinition {
  readonly id: string;
  readonly label: { readonly zh: string; readonly en: string };
  readonly description: { readonly zh: string; readonly en: string };
  readonly category: MomentCategory;
  readonly rarity: MomentRarity;
  readonly conditions: readonly MomentCondition[];
  readonly icon?: string;
}

export interface UnlockedMoment {
  /** Kept as achievementId for Redis data compat (stored field name) */
  readonly achievementId: string;
  readonly memberId: string;
  readonly unlockedAt: number;
  readonly triggerRef?: string;
}

// ── Activity Event Spine (ADR-023) ────────────────────────────────

/** Unified activity event — source of truth for all projectors */
export interface ActivityEvent {
  readonly type: ActivityEventType;
  /** Cat ID or 'co-creator' */
  readonly actorId: string;
  readonly timestamp: string;
  readonly threadId?: string;
  readonly metadata: Record<string, unknown>;
}

export type ActivityEventType =
  | 'tool_used'
  | 'task_completed'
  | 'message_sent'
  | 'review_submitted'
  | 'bug_caught'
  | 'multi_mention_dispatched'
  | 'multi_mention_completed'
  | 'multi_mention_request_completed'
  | 'deep_collab_completed'
  | 'a2a_handoff_completed'
  | 'evidence_cited'
  | 'session_sealed'
  | 'rich_block_created'
  | 'design_feedback_given'
  // Phase D6: Leadership event sources (decision + feedback dimensions)
  | 'clarification_requested' // Cat asked co-creator for missing info (explicit: AskUserQuestion tool)
  | 'decision_confirmed' // Co-creator confirmed direction (explicit: interactive block / implicit: text)
  | 'feedback_applied'; // Co-creator feedback adopted in code (future: task sourceMessageId chain)

// ── Phase D: Co-Creator Leadership (铲屎官六维) ──────────────────

/** Six leadership dimensions for the co-creator (铲屎官), independent from cat trait dimensions */
export type LeadershipDimension =
  | 'coordination' // 协调力 — 知猫善任，多猫调度
  | 'delegation' // 授权力 — 放手让猫猫自主完成
  | 'exploration' // 开拓力 — 推动边界的有效探索
  | 'guidance' // 引导力 — 给猫猫的指令清晰度
  | 'decision' // 决策力 — 拍板方向的速度和质量 (v1: shadow)
  | 'feedback'; // 反馈力 — 纠偏和正向反馈质量 (v1: shadow)

export const LEADERSHIP_DIMENSIONS: readonly LeadershipDimension[] = [
  'coordination',
  'delegation',
  'exploration',
  'guidance',
  'decision',
  'feedback',
] as const;

/** v1 scores 4 dimensions live; decision + feedback are shadow scores (recorded but not displayed) */
export const LEADERSHIP_LIVE_DIMS: readonly LeadershipDimension[] = [
  'coordination',
  'delegation',
  'exploration',
  'guidance',
] as const;

export const LEADERSHIP_SHADOW_DIMS: readonly LeadershipDimension[] = ['decision', 'feedback'] as const;

export const LEADERSHIP_LABELS: Record<LeadershipDimension, { zh: string; en: string }> = {
  coordination: { zh: '协调力', en: 'Coordination' },
  delegation: { zh: '授权力', en: 'Delegation' },
  exploration: { zh: '开拓力', en: 'Exploration' },
  guidance: { zh: '引导力', en: 'Guidance' },
  decision: { zh: '决策力', en: 'Decision' },
  feedback: { zh: '反馈力', en: 'Feedback' },
};

/** Footfall and seasoning for a single leadership dimension */
export interface LeadershipStat {
  readonly dimension: LeadershipDimension;
  readonly xp: number;
  readonly level: number;
  readonly xpToNext: number;
  /** v1: shadow dimensions are recorded but flagged */
  readonly shadow: boolean;
}

/** Co-creator leadership profile snapshot */
export interface LeadershipProfile {
  readonly stats: Record<LeadershipDimension, LeadershipStat>;
  readonly leadershipLevel: number;
  readonly totalXp: number;
  readonly currentTitle?: CatTitle;
  readonly updatedAt: number;
}

/** Leadership footfall source — events that drive co-creator leadership XP */
export type LeadershipFootfallSource =
  | 'multi_mention_dispatch' // 协调力: dispatched a multi-mention
  | 'multi_mention_success' // 协调力: multi-mention completed successfully
  | 'target_diversity' // 协调力: used diverse set of cats
  | 'task_no_intervention' // 授权力: task completed without co-creator intervention
  | 'deep_collab_initiated' // 授权力: initiated deep collab (3+ cats)
  | 'tool_category_breadth' // 开拓力: used tools across categories
  | 'new_skill_first_use' // 开拓力: first use of a new skill
  | 'feature_initiated' // 开拓力: initiated a new feature discussion
  | 'one_shot_completion' // 引导力: cat completed task on first try
  | 'low_clarification' // 引导力: session with few clarification rounds
  | 'direction_confirmed' // 决策力 (shadow/proxy): inferred from low clarification count
  | 'direction_confirmed_explicit' // 决策力 (D6): explicit UI confirm / text confirmation
  | 'feedback_applied' // 反馈力 (shadow): feedback led to improvement
  | 'clarification_observed'; // 决策力 (D6 shadow): cat asked for clarification — D7 calibration data

// ── Phase D: Leadership Titles (AC-D4) ───────────────────────────

/** Condition for unlocking a leadership title */
export type LeadershipTitleCondition =
  | { readonly type: 'leadership_dim_level'; readonly dimension: LeadershipDimension; readonly minLevel: number }
  | { readonly type: 'leadership_level'; readonly minLevel: number }
  | { readonly type: 'leadership_total_xp'; readonly minXp: number };

export interface LeadershipTitleDefinition {
  readonly id: string;
  readonly label: { readonly zh: string; readonly en: string };
  readonly description: { readonly zh: string; readonly en: string };
  readonly rarity: TitleRarity;
  readonly conditions: readonly LeadershipTitleCondition[];
}

// ── Backward-compat aliases (remove after full migration) ─────────

/** @deprecated Use TraitDimension */
export type GrowthDimension = TraitDimension;
/** @deprecated Use TRAIT_DIMENSIONS */
export const GROWTH_DIMENSIONS = TRAIT_DIMENSIONS;
/** @deprecated Use CatJourneyProfile */
export type CatGrowthProfile = CatJourneyProfile;
/** @deprecated Use JourneyOverview */
export type GrowthOverview = JourneyOverview;
/** @deprecated Use FootfallEvent */
export type XpEvent = FootfallEvent;
/** @deprecated Use FootfallSource */
export type XpSource = FootfallSource;
/** @deprecated Use MomentCategory */
export type AchievementCategory = MomentCategory;
/** @deprecated Use MomentRarity */
export type AchievementRarity = MomentRarity;
/** @deprecated Use MomentCondition */
export type AchievementCondition = MomentCondition;
/** @deprecated Use MomentDefinition */
export type AchievementDefinition = MomentDefinition;
/** @deprecated Use UnlockedMoment */
export type UnlockedAchievement = UnlockedMoment;
