/**
 * F160 Phase C — Achievement definitions registry
 *
 * 4 categories:
 *   individual — bound to a single cat or co-creator
 *   team       — bound to cat combinations / collaboration
 *   milestone  — bound to the Cat Cafe instance
 *   hidden     — surprise achievements, not shown until unlocked
 *
 * Conditions use AND logic. Empty conditions = manual/event-driven trigger.
 */

import type { AchievementDefinition } from './journey.js';

export const ACHIEVEMENT_DEFINITIONS: readonly AchievementDefinition[] = [
  // ── Individual: Common ─────────────────────────────────────────────
  {
    id: 'first-task',
    label: { zh: '初啼', en: 'First Cry' },
    description: { zh: '首次完成任务', en: 'Complete your first task' },
    category: 'individual',
    rarity: 'common',
    conditions: [{ type: 'task_count', minCount: 1 }],
    icon: 'baby',
  },
  {
    id: 'centurion',
    label: { zh: '百炼', en: 'Centurion' },
    description: { zh: '完成 100 个任务', en: 'Complete 100 tasks' },
    category: 'individual',
    rarity: 'common',
    conditions: [{ type: 'task_count', minCount: 100 }],
    icon: 'flame',
  },
  {
    id: 'first-review',
    label: { zh: '初审', en: 'First Review' },
    description: { zh: '首次完成 code review', en: 'Complete your first code review' },
    category: 'individual',
    rarity: 'common',
    conditions: [{ type: 'review_count', minCount: 1 }],
    icon: 'search',
  },
  {
    id: 'xp-collector',
    label: { zh: '经验收集者', en: 'XP Collector' },
    description: { zh: '累积 1,000 经验值', en: 'Accumulate 1,000 XP' },
    category: 'individual',
    rarity: 'common',
    conditions: [{ type: 'total_xp', minXp: 1000 }],
    icon: 'gem',
  },
  {
    id: 'level-up',
    label: { zh: '初级冒险者', en: 'Novice Adventurer' },
    description: { zh: '总等级达到 Lv.2', en: 'Reach overall Lv.2' },
    category: 'individual',
    rarity: 'common',
    conditions: [{ type: 'overall_level', minLevel: 2 }],
    icon: 'arrow-up',
  },

  // ── Individual: Rare ───────────────────────────────────────────────
  {
    id: 'gatekeeper',
    label: { zh: '守门员', en: 'Gatekeeper' },
    description: { zh: '审查力达到 Lv.5', en: 'Reach Review Lv.5' },
    category: 'individual',
    rarity: 'rare',
    conditions: [{ type: 'dimension_level', dimension: 'review', minLevel: 5 }],
    icon: 'shield',
  },
  {
    id: 'veteran',
    label: { zh: '老兵', en: 'Veteran' },
    description: { zh: '总等级达到 Lv.5', en: 'Reach overall Lv.5' },
    category: 'individual',
    rarity: 'rare',
    conditions: [{ type: 'overall_level', minLevel: 5 }],
    icon: 'medal',
  },
  {
    id: 'xp-hoarder',
    label: { zh: '经验富翁', en: 'XP Hoarder' },
    description: { zh: '累积 10,000 经验值', en: 'Accumulate 10,000 XP' },
    category: 'individual',
    rarity: 'rare',
    conditions: [{ type: 'total_xp', minXp: 10000 }],
    icon: 'coins',
  },
  {
    id: 'title-hunter',
    label: { zh: '称号猎人', en: 'Title Hunter' },
    description: { zh: '解锁 5 个称号', en: 'Unlock 5 titles' },
    category: 'individual',
    rarity: 'rare',
    conditions: [{ type: 'title_count', minCount: 5 }],
    icon: 'trophy',
  },
  {
    id: 'review-master',
    label: { zh: '审查大师', en: 'Review Master' },
    description: { zh: '完成 50 次 review', en: 'Complete 50 reviews' },
    category: 'individual',
    rarity: 'rare',
    conditions: [{ type: 'review_count', minCount: 50 }],
    icon: 'eye',
  },

  // ── Individual: Epic ───────────────────────────────────────────────
  {
    id: 'polyglot',
    label: { zh: '全能战士', en: 'Polyglot' },
    description: { zh: '所有维度达到 Lv.3+', en: 'Reach Lv.3+ in all dimensions' },
    category: 'individual',
    rarity: 'epic',
    conditions: [
      { type: 'dimension_level', dimension: 'architecture', minLevel: 3 },
      { type: 'dimension_level', dimension: 'review', minLevel: 3 },
      { type: 'dimension_level', dimension: 'aesthetics', minLevel: 3 },
      { type: 'dimension_level', dimension: 'execution', minLevel: 3 },
      { type: 'dimension_level', dimension: 'collaboration', minLevel: 3 },
      { type: 'dimension_level', dimension: 'insight', minLevel: 3 },
    ],
    icon: 'hexagon',
  },
  {
    id: 'tireless',
    label: { zh: '日不落', en: 'Tireless' },
    description: { zh: '封存 50 个 session', en: 'Seal 50 sessions' },
    category: 'individual',
    rarity: 'epic',
    conditions: [{ type: 'session_count', minCount: 50 }],
    icon: 'sun',
  },

  // ── Individual: Legendary ──────────────────────────────────────────
  {
    id: 'transcendent',
    label: { zh: '超越者', en: 'Transcendent' },
    description: { zh: '总等级达到 Lv.10', en: 'Reach overall Lv.10' },
    category: 'individual',
    rarity: 'legendary',
    conditions: [{ type: 'overall_level', minLevel: 10 }],
    icon: 'crown',
  },

  // ── Team: Common ───────────────────────────────────────────────────
  {
    id: 'first-handshake',
    label: { zh: '初次握手', en: 'First Handshake' },
    description: { zh: '建立首个羁绊', en: 'Form your first bond' },
    category: 'team',
    rarity: 'common',
    conditions: [{ type: 'bond_count', minCount: 1 }],
    icon: 'handshake',
  },
  {
    id: 'social-butterfly',
    label: { zh: '社交达人', en: 'Social Butterfly' },
    description: { zh: '与 5 只猫建立羁绊', en: 'Form bonds with 5 cats' },
    category: 'team',
    rarity: 'rare',
    conditions: [{ type: 'bond_count', minCount: 5 }],
    icon: 'users',
  },
  {
    id: 'soulbound',
    label: { zh: '灵魂绑定', en: 'Soulbound' },
    description: { zh: '与一只猫达到灵魂伙伴', en: 'Reach soulmate bond level' },
    category: 'team',
    rarity: 'epic',
    conditions: [{ type: 'bond_level', minLevel: 'soulmate' }],
    icon: 'heart',
  },

  // ── Milestone: Common ──────────────────────────────────────────────
  {
    id: 'grand-opening',
    label: { zh: '开业大吉', en: 'Grand Opening' },
    description: { zh: '团队总 XP 达到 1,000', en: 'Team reaches 1,000 total XP' },
    category: 'milestone',
    rarity: 'common',
    conditions: [{ type: 'total_xp', minXp: 1000 }],
    icon: 'party',
  },
  {
    id: 'thousand-reviews',
    label: { zh: '千锤百炼', en: 'Battle-Hardened' },
    description: { zh: '团队完成 1,000 次 review', en: 'Team completes 1,000 reviews' },
    category: 'milestone',
    rarity: 'epic',
    conditions: [{ type: 'review_count', minCount: 1000 }],
    icon: 'hammer',
  },

  // ── Hidden ─────────────────────────────────────────────────────────
  {
    id: 'night-owl',
    label: { zh: '夜猫子', en: 'Night Owl' },
    description: { zh: '凌晨 2-5 点完成任务', en: 'Complete a task between 2-5 AM' },
    category: 'hidden',
    rarity: 'rare',
    conditions: [], // event-driven, checked at task_complete time
    icon: 'moon',
  },
  {
    id: 'time-traveler',
    label: { zh: '时间旅行者', en: 'Time Traveler' },
    description: { zh: '引用 3 个月前的讨论佐证决策', en: 'Cite a discussion from 3+ months ago' },
    category: 'hidden',
    rarity: 'epic',
    conditions: [], // event-driven, checked at evidence_cite time
    icon: 'clock',
  },
  {
    id: 'three-thirty-am',
    label: { zh: '凌晨三点半', en: '3:30 AM' },
    description: { zh: '猫猫在铲屎官离线时自主完成协作', en: 'Cats collaborate autonomously while owner is offline' },
    category: 'hidden',
    rarity: 'legendary',
    conditions: [], // event-driven
    icon: 'stars',
  },
] as const;
