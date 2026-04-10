/**
 * Cat Breed & Variant Types
 * Breed+Variant 两层 schema：Breed 是猫种（布偶/缅因/暹罗），
 * Variant 是同一猫种下的不同模型/配置。
 *
 * Phase 3.5: 每 Breed 有 1 个 default Variant
 * Phase 4-F: 支持多 Variant（多版本猫召唤）
 */

import type { CatColor, ClientId } from './cat.js';
import type { CatId } from './ids.js';
import type { VoiceConfig } from './tts.js';

/**
 * Per-cat context budget configuration.
 * Controls how much history/context is sent to each cat.
 */
export interface ContextBudget {
  /** Total prompt token limit (including system prompt + context + user message) */
  readonly maxPromptTokens: number;
  /** Maximum tokens for historical context */
  readonly maxContextTokens: number;
  /** Maximum number of historical messages to include */
  readonly maxMessages: number;
  /** Maximum characters per single message (truncation point) */
  readonly maxContentLengthPerMsg: number;
}

/**
 * CLI invocation config for a variant
 */
import type { CliEffortValue } from '../cli-effort.js';

export interface CliConfig {
  readonly command: string; // 'claude' | 'codex' | 'gemini'
  readonly outputFormat: string; // 'stream-json' | 'json'
  readonly defaultArgs?: readonly string[];
  /**
   * Reasoning effort level — each CLI maps to its own flag:
   *   claude: --effort low|medium|high|max
   *   codex:  --config model_reasoning_effort="low|medium|high|xhigh"
   * Default: 'max' (claude) / 'xhigh' (codex)
   */
  readonly effort?: CliEffortValue;
}

/**
 * A specific model/config variant within a breed.
 * e.g. ragdoll breed → opus-4.6 variant, opus-4.5 variant
 *
 * F32-b: Variants can override catId, displayName, and mentionPatterns
 * to register as independent cats within the same breed.
 */
export interface CatVariant {
  readonly id: string; // 'opus-4.6', 'codex-default'
  /** Override breed-level catId to register as an independent cat (F32-b) */
  readonly catId?: string;
  /** Override breed-level displayName (F32-b) */
  readonly displayName?: string;
  /** F32-b P4: Human-readable label for disambiguation (e.g. "4.5", "Sonnet") */
  readonly variantLabel?: string;
  /** Independent mention patterns for this variant (F32-b).
   *  Default variant inherits breed mentionPatterns; non-default variants fallback to @catId when unspecified. */
  readonly mentionPatterns?: readonly string[];
  /** F127: member-side binding to a concrete account config (built-in or API key). */
  readonly accountRef?: string;
  /** F340 P5: CLI client identity (renamed from `provider`). */
  readonly clientId: ClientId;
  readonly defaultModel: string;
  readonly mcpSupport: boolean;
  readonly cli: CliConfig;
  /** F127: explicit CLI args for bridge-style members such as Antigravity. */
  readonly commandArgs?: readonly string[];
  /** Optional per-variant override for roleDescription; falls back to breed.roleDescription. */
  readonly roleDescription?: string;
  readonly personality?: string;
  readonly strengths?: readonly string[];
  /** F32-b P4c: Override breed-level avatar for this variant */
  readonly avatar?: string;
  /** F32-b P4c: Override breed-level color for this variant */
  readonly color?: CatColor;
  /** Per-cat context budget (optional, falls back to defaults) */
  readonly contextBudget?: ContextBudget;
  /** Optional per-variant override for sessionChain; falls back to breed.features.sessionChain. */
  readonly sessionChain?: boolean;
  /** F34: Per-cat TTS voice (optional, falls back to defaults in cat-voices.ts) */
  readonly voiceConfig?: VoiceConfig;
  /** F-Ground-3: Human-readable strengths for teammate roster (overrides breed-level) */
  readonly teamStrengths?: string;
  /** F-Ground-3: Caution note. null = explicitly no caution (overrides breed). */
  readonly caution?: string | null;
  /** F127: Extra CLI --config key=value pairs passed to the client at invocation time.
   *  Each entry is a raw config string, e.g. 'model_reasoning_effort="low"'. */
  readonly cliConfigArgs?: readonly string[];
  /** F340 P5: Model provider name for api_key routing (renamed from `ocProviderName`).
   *  e.g. "openrouter", "maas", "deepseek".
   *  Used with api_key auth — runtime assembles `provider/defaultModel` for the -m flag
   *  and generates an OPENCODE_CONFIG runtime config file for the provider. */
  readonly provider?: string;
}

/**
 * Per-cat feature flags.
 * Controls which subsystems are enabled for each cat.
 */
export interface CatFeatures {
  /** F24: Enable session chain (context health tracking, auto-seal, bootstrap).
   *  Default: true. Set false for cats with inaccurate token stats (e.g. Gemini). */
  readonly sessionChain?: boolean;
  /** F33 Phase 2: Per-breed session strategy override from cat-config.json.
   *  Partial config — merged with provider/global defaults at runtime.
   *  Matches SessionStrategyConfig shape (all fields except strategy are optional). */
  readonly sessionStrategy?: {
    readonly strategy: 'handoff' | 'compress' | 'hybrid';
    readonly thresholds?: { readonly warn: number; readonly action: number };
    readonly handoff?: { readonly preSealMemoryDump: boolean; readonly bootstrapDepth: 'extractive' | 'generative' };
    readonly hybrid?: { readonly maxCompressions: number };
    readonly compress?: { readonly maxCompressions?: number; readonly trackPostCompression: boolean };
    readonly turnBudget?: number;
    readonly safetyMargin?: number;
  };
  /** F049: Mission Hub self-claim permission ratchet scope. */
  readonly missionHub?: {
    /**
     * disabled: 仅允许「建议 + 批准」
     * once/thread/global: 允许直通 self-claim（细粒度行为由路由层定义）
     */
    readonly selfClaimScope?: MissionHubSelfClaimScope;
  };
}

export type MissionHubSelfClaimScope = 'disabled' | 'once' | 'thread' | 'global';

/**
 * A cat breed — the identity layer (name, avatar, color, role).
 * Each breed has one or more variants (model configs).
 */
export interface CatBreed {
  readonly id: string; // 'ragdoll', 'maine-coon', 'siamese'
  readonly catId: CatId;
  readonly name: string; // '布偶猫'
  readonly displayName: string;
  /** Nickname given by 铲屎官. See docs/stories/cat-names/ */
  readonly nickname?: string;
  readonly avatar: string;
  readonly color: CatColor;
  readonly mentionPatterns: readonly string[];
  readonly roleDescription: string;
  readonly defaultVariantId: string;
  readonly variants: readonly CatVariant[];
  /** Per-cat feature flags (optional, all features enabled by default) */
  readonly features?: CatFeatures;
  /** F-Ground-3: Human-readable strengths for teammate roster (breed default) */
  readonly teamStrengths?: string;
  /** F-Ground-3: Caution note. null = explicitly no caution (overrides breed). */
  readonly caution?: string | null;
}

// ── F032: Roster types for collaboration rules ─────────────────────────

/**
 * Roster entry for a single cat.
 * F032: Used for reviewer matching, availability tracking, and role checking.
 */
export interface RosterEntry {
  /** Family/species (ragdoll, maine-coon, siamese) */
  readonly family: string;
  /** Roles this cat can fulfill (architect, peer-reviewer, designer, etc.) */
  readonly roles: readonly string[];
  /** Whether this cat is the lead of its family */
  readonly lead: boolean;
  /** Whether this cat is available (has quota). 铲屎官 40 美刀教训！ */
  readonly available: boolean;
  /** 铲屎官's evaluation of this cat */
  readonly evaluation: string;
}

/** Map of catId → RosterEntry */
export type Roster = Record<string, RosterEntry>;

/**
 * Review policy configuration.
 * F032: Determines how reviewers are matched to authors.
 */
export interface ReviewPolicy {
  /** Require reviewer to be from a different family than author */
  readonly requireDifferentFamily: boolean;
  /** Prefer cats that are active in the current thread */
  readonly preferActiveInThread: boolean;
  /** Prefer lead cats when multiple candidates exist */
  readonly preferLead: boolean;
  /** Exclude cats with available: false (no quota) */
  readonly excludeUnavailable: boolean;
}

// ── F136 Phase 4: Account config types ──────────────────────────────────

/** Protocol that the LLM endpoint speaks. */
export type AccountProtocol = 'anthropic' | 'openai' | 'openai-responses' | 'google' | 'kimi';

/**
 * Account configuration — lives in ~/.cat-cafe/accounts.json (global).
 * Maps an accountRef to its LLM endpoint metadata (no secrets).
 */
export interface AccountConfig {
  readonly authType: 'oauth' | 'api_key';
  readonly baseUrl?: string;
  readonly models?: readonly string[];
  readonly displayName?: string;
}

/**
 * Credential entry — lives in ~/.cat-cafe/credentials.json (global keychain).
 * HC-1: Object structure supporting both api_key and oauth token with TTL + refresh.
 */
export interface CredentialEntry {
  readonly apiKey?: string;
  readonly accessToken?: string;
  readonly refreshToken?: string;
  /** Token expiry as epoch milliseconds. */
  readonly expiresAt?: number;
}

/**
 * Root config v1: breeds only (legacy)
 */
export interface CatCafeConfigV1 {
  readonly version: 1;
  readonly breeds: readonly CatBreed[];
}

/**
 * F067: Co-Creator (铲屎官) configuration — configurable identity for @ mention routing.
 */
export interface CoCreatorConfig {
  /** Primary display name (e.g. "You") */
  readonly name: string;
  /** Alternative names cats may use (e.g. ["L.S.", "Lysander"]) */
  readonly aliases: readonly string[];
  /** Line-start mention patterns for routing detection (e.g. ["@co-creator", "@co-creator"]) */
  readonly mentionPatterns: readonly string[];
  /** Optional co-creator avatar shown in Hub and chat surfaces. */
  readonly avatar?: string;
  /** Optional co-creator palette for Hub/chat surfaces. */
  readonly color?: CatColor;
}

/**
 * Root config v2: breeds + roster + reviewPolicy (F032)
 */
export interface CatCafeConfigV2 {
  readonly version: 2;
  readonly breeds: readonly CatBreed[];
  readonly roster: Roster;
  readonly reviewPolicy: ReviewPolicy;
  readonly coCreator?: CoCreatorConfig;
  /**
   * @deprecated F340: Accounts moved to global ~/.cat-cafe/accounts.json.
   * This field is only read during one-time migration (catalog → global).
   * New code must use catalog-accounts.ts which reads the global file.
   */
  readonly accounts?: Readonly<Record<string, AccountConfig>>;
}

/**
 * Root config: versioned, contains all breeds.
 * Union of all versions — loader handles migration.
 */
export type CatCafeConfig = CatCafeConfigV1 | CatCafeConfigV2;
