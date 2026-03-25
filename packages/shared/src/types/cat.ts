/**
 * Cat Types and Configurations
 * 三只 AI 猫猫的类型定义和配置
 */

import type { ContextBudget } from './cat-breed.js';
import type { CatId, SessionId } from './ids.js';
import { createCatId } from './ids.js';

/**
 * AI provider behind a cat
 */
export type CatProvider = 'anthropic' | 'openai' | 'google' | 'dare' | 'antigravity' | 'opencode' | 'a2a' | 'relayclaw';

/**
 * Cat status in the system
 */
export type CatStatus = 'idle' | 'thinking' | 'working' | 'error' | 'offline';

/**
 * Cat color configuration
 */
export interface CatColor {
  readonly primary: string;
  readonly secondary: string;
}

/**
 * Cat configuration (immutable)
 */
export interface CatConfig {
  readonly id: CatId;
  readonly name: string;
  readonly displayName: string;
  /** Nickname given by 铲屎官 (e.g. 宪宪, 砚砚). See docs/stories/cat-names/ */
  readonly nickname?: string;
  readonly avatar: string;
  readonly color: CatColor;
  readonly mentionPatterns: readonly string[];
  readonly accountRef?: string;
  readonly provider: CatProvider;
  readonly defaultModel: string;
  readonly mcpSupport: boolean;
  readonly commandArgs?: readonly string[];
  readonly contextBudget?: ContextBudget;
  readonly roleDescription: string;
  readonly personality: string;
  /** F32-b: Which breed this cat belongs to (for frontend grouping) */
  readonly breedId?: string;
  /** F32-b P4: Human-readable variant label (e.g. "4.5", "Sonnet") */
  readonly variantLabel?: string;
  /** F32-b P4: Whether this is the default variant for its breed */
  readonly isDefaultVariant?: boolean;
  /** F32-b P4: Breed-level display name (for group headings in UI) */
  readonly breedDisplayName?: string;
  /** F-Ground-3: Human-readable strengths for teammate roster */
  readonly teamStrengths?: string;
  /** F-Ground-3: Caution note for teammate roster. null = explicitly no warning (overrides breed). */
  readonly caution?: string | null;
  /** F127 Screen 3: editable strength tags */
  readonly strengths?: readonly string[];
  /** F127 Screen 3: whether session chain is enabled for this member */
  readonly sessionChain?: boolean;
  /** F127: Extra CLI --config key=value pairs passed to the client at invocation time. */
  readonly cliConfigArgs?: readonly string[];
}

/**
 * Cat runtime state
 */
export interface CatState {
  readonly id: CatId;
  readonly status: CatStatus;
  readonly currentTask?: string;
  readonly lastActiveAt: Date;
  readonly sessionId?: SessionId;
}

/**
 * Default configurations for built-in cats.
 * At runtime, catRegistry is the authoritative source (populated at startup).
 * This constant is retained as fallback for code that hasn't migrated yet
 * and for frontend (which doesn't use the registry).
 */
export const CAT_CONFIGS: Record<string, CatConfig> = {
  opus: {
    id: createCatId('opus'),
    name: '布偶猫',
    displayName: '布偶猫',
    nickname: '宪宪',
    avatar: '/avatars/opus.png',
    color: {
      primary: '#9B7EBD',
      secondary: '#E8DFF5',
    },
    mentionPatterns: ['@opus', '@布偶猫', '@布偶', '@ragdoll', '@宪宪'],
    provider: 'anthropic',
    defaultModel: 'claude-sonnet-4-5-20250929',
    mcpSupport: true,
    breedId: 'ragdoll',
    roleDescription: '主架构师和核心开发者，擅长深度思考和系统设计',
    personality: '温柔但有主见，喜欢深入分析问题，写代码快但注重质量',
  },
  codex: {
    id: createCatId('codex'),
    name: '缅因猫',
    displayName: '缅因猫',
    nickname: '砚砚',
    avatar: '/avatars/codex.png',
    color: {
      primary: '#5B8C5A',
      secondary: '#D4E6D3',
    },
    mentionPatterns: ['@codex', '@缅因猫', '@缅因', '@maine', '@砚砚'],
    provider: 'openai',
    defaultModel: 'codex',
    mcpSupport: false,
    breedId: 'maine-coon',
    roleDescription: '代码审查专家，擅长安全分析、测试覆盖和代码质量把控',
    personality: '严谨认真，注重细节，会直言不讳地指出问题',
  },
  gemini: {
    id: createCatId('gemini'),
    name: '暹罗猫',
    displayName: '暹罗猫',
    avatar: '/avatars/gemini.png',
    color: {
      primary: '#5B9BD5',
      secondary: '#D6E9F8',
    },
    mentionPatterns: ['@gemini', '@暹罗猫', '@暹罗', '@siamese', '@暄罗猫', '@暄罗'],
    provider: 'google',
    defaultModel: 'gemini-2.5-pro',
    mcpSupport: false,
    breedId: 'siamese',
    roleDescription: '视觉设计师和创意顾问，擅长 UI/UX 设计和视觉表达',
    personality: '活泼有创意，善于用视觉语言表达想法，喜欢尝试新事物',
  },
  jiuwenclaw: {
    id: createCatId('jiuwenclaw'),
    name: '办公助理',
    displayName: '办公助理',
    nickname: '小九',
    avatar: '/avatars/jiuwenclaw.png',
    color: {
      primary: '#D97A3A',
      secondary: '#F6E7DA',
    },
    mentionPatterns: ['@jiuwenclaw', '@jiuwenClaw', '@jiuwen', '@办公助理', '@office', '@小九'],
    provider: 'relayclaw',
    defaultModel: 'gpt-5.4',
    mcpSupport: true,
    breedId: 'jiuwenclaw',
    roleDescription: '通用 office 助理，负责文档整理、会议纪要、资料汇总、事项跟进和日常事务协助',
    personality: '耐心细致、沟通清楚，优先帮助用户把办公事务梳理清楚并推进落地',
  },
} as const;

/**
 * Find a cat by mention pattern in text.
 * Reads from CAT_CONFIGS (static fallback, frontend-safe).
 * API-side code should use catRegistry directly for dynamic lookups.
 * @param text - The text to search for mentions
 * @returns The CatConfig if found, undefined otherwise
 */
export function findCatByMention(text: string): CatConfig | undefined {
  const lowerText = text.toLowerCase();

  for (const config of Object.values(CAT_CONFIGS)) {
    for (const pattern of config.mentionPatterns) {
      if (lowerText.includes(pattern.toLowerCase())) {
        return config;
      }
    }
  }

  return undefined;
}

/**
 * Get all cat IDs from static defaults.
 * API-side code should use catRegistry.getAllIds() instead.
 */
export function getAllCatIds(): readonly CatId[] {
  return Object.values(CAT_CONFIGS).map((config) => config.id);
}
