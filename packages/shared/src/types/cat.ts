/**
 * Cat Types and Configurations
 * 三只 AI 猫猫的类型定义和配置
 */

import type { CliConfig, ContextBudget } from './cat-breed.js';
import type { CatId, SessionId } from './ids.js';
import { createCatId } from './ids.js';

/**
 * CLI client identity used to invoke a cat (e.g. 'anthropic' → claude CLI, 'openai' → codex CLI).
 * Renamed from CatProvider in clowder-ai#340 P5.
 */
export type ClientId =
  | 'anthropic'
  | 'openai'
  | 'google'
  | 'kimi'
  | 'dare'
  | 'antigravity'
  | 'opencode'
  | 'a2a'
  | 'catagent';

/** @deprecated clowder-ai#340: Use {@link ClientId} instead. Kept as alias for backward compatibility. */
export type CatProvider = ClientId;

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
  /** clowder-ai#340 P5: CLI client identity (renamed from `provider`). */
  readonly clientId: ClientId;
  readonly defaultModel: string;
  readonly mcpSupport: boolean;
  readonly cli?: CliConfig;
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
  /** F167 Phase E (KD-20): hard task restrictions — natural-language bans
   *  (e.g. `["禁止写代码"]`). Surfaced to teammates via buildTeammateRoster
   *  and to the cat itself via buildStaticIdentity. Data-driven replacement
   *  for the retired L3 role-gate hardcoded regex. */
  readonly restrictions?: readonly string[];
  /** F127 Screen 3: editable strength tags */
  readonly strengths?: readonly string[];
  /** F127 Screen 3: whether session chain is enabled for this member */
  readonly sessionChain?: boolean;
  /** F127: Extra CLI --config key=value pairs passed to the client at invocation time. */
  readonly cliConfigArgs?: readonly string[];
  /** clowder-ai#340 P5: Model provider name for api_key routing (renamed from `ocProviderName`).
   *  e.g. "openrouter", "maas", "deepseek". Runtime assembles provider/model for the -m flag. */
  readonly provider?: string;
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
