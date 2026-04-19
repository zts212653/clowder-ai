/**
 * F160 Phase B — Title definitions registry
 *
 * Static list of all titles that can be unlocked via growth attributes.
 * Conditions use AND logic — all must be met for unlock.
 *
 * Rarity tiers:
 *   common   — single dimension Lv.1-2
 *   rare     — single dimension Lv.3-5
 *   epic     — multi-dimension combo
 *   legendary — extreme achievement
 */

import type { TitleDefinition } from './journey.js';

export const TITLE_DEFINITIONS: readonly TitleDefinition[] = [
  // ── Common (single dimension low level) ──────────────────────────
  {
    id: 'first-step',
    label: { zh: '初出茅庐', en: 'First Step' },
    description: { zh: '任意维度达到 Lv.1', en: 'Reach Lv.1 in any dimension' },
    rarity: 'common',
    conditions: [{ type: 'overall_level', minLevel: 1 }],
  },
  {
    id: 'doer',
    label: { zh: '实干家', en: 'Doer' },
    description: { zh: '执行力达到 Lv.2', en: 'Reach Lv.2 in Execution' },
    rarity: 'common',
    conditions: [{ type: 'dimension_level', dimension: 'execution', minLevel: 2 }],
  },
  {
    id: 'thinker',
    label: { zh: '思考者', en: 'Thinker' },
    description: { zh: '架构力达到 Lv.2', en: 'Reach Lv.2 in Architecture' },
    rarity: 'common',
    conditions: [{ type: 'dimension_level', dimension: 'architecture', minLevel: 2 }],
  },
  {
    id: 'team-player',
    label: { zh: '团队之心', en: 'Team Player' },
    description: { zh: '协作力达到 Lv.2', en: 'Reach Lv.2 in Collaboration' },
    rarity: 'common',
    conditions: [{ type: 'dimension_level', dimension: 'collaboration', minLevel: 2 }],
  },

  // ── Rare (single dimension mid level) ────────────────────────────
  {
    id: 'eagle-eye',
    label: { zh: '鹰眼', en: 'Eagle Eye' },
    description: { zh: '审查力达到 Lv.5', en: 'Reach Lv.5 in Review' },
    rarity: 'rare',
    conditions: [{ type: 'dimension_level', dimension: 'review', minLevel: 5 }],
  },
  {
    id: 'artisan',
    label: { zh: '匠人', en: 'Artisan' },
    description: { zh: '审美力达到 Lv.3', en: 'Reach Lv.3 in Aesthetics' },
    rarity: 'rare',
    conditions: [{ type: 'dimension_level', dimension: 'aesthetics', minLevel: 3 }],
  },
  {
    id: 'scout',
    label: { zh: '侦察兵', en: 'Scout' },
    description: { zh: '洞察力达到 Lv.3', en: 'Reach Lv.3 in Insight' },
    rarity: 'rare',
    conditions: [{ type: 'dimension_level', dimension: 'insight', minLevel: 3 }],
  },
  {
    id: 'veteran',
    label: { zh: '老兵', en: 'Veteran' },
    description: { zh: '执行力达到 Lv.5', en: 'Reach Lv.5 in Execution' },
    rarity: 'rare',
    conditions: [{ type: 'dimension_level', dimension: 'execution', minLevel: 5 }],
  },
  {
    id: 'diplomat',
    label: { zh: '外交官', en: 'Diplomat' },
    description: { zh: '协作力达到 Lv.4', en: 'Reach Lv.4 in Collaboration' },
    rarity: 'rare',
    conditions: [{ type: 'dimension_level', dimension: 'collaboration', minLevel: 4 }],
  },

  // ── Epic (multi-dimension combo) ─────────────────────────────────
  {
    id: 'chief-architect',
    label: { zh: '首席架构师', en: 'Chief Architect' },
    description: { zh: '架构力 Lv.4 + 协作力 Lv.3', en: 'Architecture Lv.4 + Collaboration Lv.3' },
    rarity: 'epic',
    conditions: [
      { type: 'dimension_level', dimension: 'architecture', minLevel: 4 },
      { type: 'dimension_level', dimension: 'collaboration', minLevel: 3 },
    ],
  },
  {
    id: 'full-stack',
    label: { zh: '全栈战士', en: 'Full Stack' },
    description: { zh: '执行力 Lv.4 + 审美力 Lv.3', en: 'Execution Lv.4 + Aesthetics Lv.3' },
    rarity: 'epic',
    conditions: [
      { type: 'dimension_level', dimension: 'execution', minLevel: 4 },
      { type: 'dimension_level', dimension: 'aesthetics', minLevel: 3 },
    ],
  },
  {
    id: 'sentinel',
    label: { zh: '守门员', en: 'Sentinel' },
    description: { zh: '审查力 Lv.4 + 洞察力 Lv.3', en: 'Review Lv.4 + Insight Lv.3' },
    rarity: 'epic',
    conditions: [
      { type: 'dimension_level', dimension: 'review', minLevel: 4 },
      { type: 'dimension_level', dimension: 'insight', minLevel: 3 },
    ],
  },

  // ── Legendary (extreme achievement) ──────────────────────────────
  {
    id: 'prophet',
    label: { zh: '预言家', en: 'Prophet' },
    description: { zh: '洞察力 Lv.5 + 审查力 Lv.4', en: 'Insight Lv.5 + Review Lv.4' },
    rarity: 'legendary',
    conditions: [
      { type: 'dimension_level', dimension: 'insight', minLevel: 5 },
      { type: 'dimension_level', dimension: 'review', minLevel: 4 },
    ],
  },
  {
    id: 'polymath',
    label: { zh: '全才', en: 'Polymath' },
    description: { zh: '总等级达到 Lv.5', en: 'Reach overall Lv.5' },
    rarity: 'legendary',
    conditions: [{ type: 'overall_level', minLevel: 5 }],
  },
] as const;
