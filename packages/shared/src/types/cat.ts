/**
 * Cat Types and Configurations
 * 三只 AI 猫猫的类型定义和配置
 */

import type { CliConfig, ContextBudget } from './cat-breed.js';
import type { CatId, SessionId } from './ids.js';
import type { VoiceConfig } from './tts.js';

/**
 * CLI client identity used to invoke a cat (e.g. 'anthropic' → claude CLI, 'openai' → codex CLI).
 * Renamed from CatProvider in clowder-ai#340 P5.
 */
export type ClientId =
  | 'anthropic'
  | 'openai'
  | 'google'
  | 'kimi'
  | 'antigravity'
  | 'opencode'
  | 'a2a'
  | 'catagent'
  | 'acp'; // F161: Generic ACP client for unknown/user-provided ACP agents

/** @deprecated clowder-ai#340: Use {@link ClientId} instead. Kept as alias for backward compatibility. */
export type CatProvider = ClientId;

/** F159 Phase F: native CatAgent tool capability tier. */
export type NativeToolLevel = 'L0' | 'L1' | 'L2';

/**
 * F159 Phase G G2: CatAgent wire protocol selection.
 *
 * Selects which `CatAgentProtocolAdapter` the factory dispatches for a
 * `clientId='catagent'` member:
 * - `anthropic-messages` → `AnthropicMessagesAdapter` (G1 default, Anthropic
 *   Messages API `POST /v1/messages` + `x-api-key` + `anthropic-version`)
 * - `openai-chat` → `OpenAIChatAdapter` (G2 new, OpenAI Chat Completions
 *   `POST /v1/chat/completions` + `Authorization: Bearer`)
 *
 * Omitted defaults to `'anthropic-messages'` to preserve G1 catagent members'
 * behavior across the G2 rollout. Only meaningful when `clientId === 'catagent'`;
 * persistence is gated to catagent-only at runtime catalog / route / Hub layers.
 *
 * See AC-G13 + KD-20 (fail-closed dispatch, no runtime protocol guessing).
 */
export type CatAgentProtocol = 'anthropic-messages' | 'openai-chat';

/** F159 Phase F: allowlist-first command policy for CatAgent run_command. */
export interface CommandPolicyEntry {
  readonly binary: string;
  readonly allowedSubcommands?: readonly string[];
  readonly allowedFlags?: readonly string[];
  readonly allowedArgPatterns?: readonly string[];
  /** Defense-in-depth only; never grants permission by itself. */
  readonly deniedFlags?: readonly string[];
}

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
 * F210 Phase G: Isolated Antigravity CLI profile binding.
 * The API runtime uses this to create a per-cat HOME sandbox before invoking `agy`.
 */
export interface AgyProfileConfig {
  readonly enabled?: boolean;
  readonly profileId?: string;
  readonly homeRoot?: string;
  readonly model?: string;
  readonly autoApprove?: boolean;
  readonly trustedWorkspaces?: readonly string[];
}

/**
 * Cat configuration (immutable)
 */
export interface CatConfig {
  readonly id: CatId;
  readonly name: string;
  readonly displayName: string;
  /** Nickname given by co-creator (e.g. 宪宪, 砚砚). See docs/stories/cat-names/ */
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
  readonly agyProfile?: AgyProfileConfig;
  readonly commandArgs?: readonly string[];
  readonly contextBudget?: ContextBudget;
  /** F159 Phase F: CatAgent native tool level. Omitted = L0. */
  readonly nativeToolLevel?: NativeToolLevel;
  /** F159 Phase F: allowlist-first command policy for L2 run_command. */
  readonly commandPolicy?: readonly CommandPolicyEntry[];
  /** F159 Phase G G2 (AC-G13): CatAgent wire protocol selection. Only
   *  meaningful when `clientId === 'catagent'`; omitted defaults to
   *  `'anthropic-messages'` (G1 catagent behavior preserved). */
  readonly catAgentProtocol?: CatAgentProtocol;
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
  /** F103/F190: Per-cat TTS voice configuration, including optional refAudio. */
  readonly voiceConfig?: VoiceConfig;
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
