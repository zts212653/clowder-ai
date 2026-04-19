/**
 * F160 Phase D (AC-D4) — Leadership title definitions
 *
 * Title path for the co-creator (铲屎官):
 *   初心铲屎官 → 协调新手 → 授权达人 → 开拓先锋 → 团队指挥官 → 猫猫军师
 *
 * Only live dimensions (coordination, delegation, exploration, guidance)
 * are used in conditions. Shadow dimensions are excluded.
 */

import type { LeadershipTitleDefinition } from './journey.js';

export const LEADERSHIP_TITLE_DEFINITIONS: readonly LeadershipTitleDefinition[] = [
  // ── Common ──────────────────────────────────────────────────────
  {
    id: 'beginner-scooper',
    label: { zh: '初心铲屎官', en: 'Beginner Scooper' },
    description: { zh: '领导力任意维度达到 Lv.1', en: 'Reach Lv.1 in any leadership dimension' },
    rarity: 'common',
    conditions: [{ type: 'leadership_level', minLevel: 1 }],
  },
  {
    id: 'coordination-rookie',
    label: { zh: '协调新手', en: 'Coordination Rookie' },
    description: { zh: '协调力达到 Lv.2', en: 'Reach Lv.2 in Coordination' },
    rarity: 'common',
    conditions: [{ type: 'leadership_dim_level', dimension: 'coordination', minLevel: 2 }],
  },

  // ── Rare ────────────────────────────────────────────────────────
  {
    id: 'delegation-master',
    label: { zh: '授权达人', en: 'Delegation Master' },
    description: { zh: '授权力达到 Lv.3', en: 'Reach Lv.3 in Delegation' },
    rarity: 'rare',
    conditions: [{ type: 'leadership_dim_level', dimension: 'delegation', minLevel: 3 }],
  },
  {
    id: 'explorer-pioneer',
    label: { zh: '开拓先锋', en: 'Explorer Pioneer' },
    description: { zh: '开拓力达到 Lv.3', en: 'Reach Lv.3 in Exploration' },
    rarity: 'rare',
    conditions: [{ type: 'leadership_dim_level', dimension: 'exploration', minLevel: 3 }],
  },
  {
    id: 'guidance-mentor',
    label: { zh: '引导之师', en: 'Guidance Mentor' },
    description: { zh: '引导力达到 Lv.3', en: 'Reach Lv.3 in Guidance' },
    rarity: 'rare',
    conditions: [{ type: 'leadership_dim_level', dimension: 'guidance', minLevel: 3 }],
  },

  // ── Epic ────────────────────────────────────────────────────────
  {
    id: 'team-commander',
    label: { zh: '团队指挥官', en: 'Team Commander' },
    description: { zh: '协调力 Lv.4 + 引导力 Lv.3', en: 'Coordination Lv.4 + Guidance Lv.3' },
    rarity: 'epic',
    conditions: [
      { type: 'leadership_dim_level', dimension: 'coordination', minLevel: 4 },
      { type: 'leadership_dim_level', dimension: 'guidance', minLevel: 3 },
    ],
  },
  {
    id: 'hands-off-leader',
    label: { zh: '放手型领导', en: 'Hands-off Leader' },
    description: { zh: '授权力 Lv.4 + 开拓力 Lv.3', en: 'Delegation Lv.4 + Exploration Lv.3' },
    rarity: 'epic',
    conditions: [
      { type: 'leadership_dim_level', dimension: 'delegation', minLevel: 4 },
      { type: 'leadership_dim_level', dimension: 'exploration', minLevel: 3 },
    ],
  },

  // ── Legendary ───────────────────────────────────────────────────
  {
    id: 'cat-strategist',
    label: { zh: '猫猫军师', en: 'Cat Strategist' },
    description: { zh: '领导力总等级达到 Lv.5', en: 'Reach leadership level 5' },
    rarity: 'legendary',
    conditions: [{ type: 'leadership_level', minLevel: 5 }],
  },
] as const;
