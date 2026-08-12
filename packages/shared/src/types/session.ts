/**
 * Session Chain Types
 * F24: Thread → N Sessions per cat, with context health tracking.
 *
 * Session lifecycle: active → sealing → sealed
 * - active: currently in use (one per cat per thread)
 * - sealing: writing transcript + generating digest (Phase B)
 * - sealed: immutable snapshot, readable by sub-agents (Phase C+)
 */

import type { CatId } from './ids.js';
import type { CatHandoffNote } from './session-handoff-proposal.js';

export type SessionStatus = 'active' | 'sealing' | 'sealed';

/**
 * Effective capacity owned by one active session.
 *
 * The pin deliberately stores only the resolved capacity — no provider/model
 * fingerprint or reusable carrier proof. A later invocation may shrink this
 * value, but only a new session may expand it.
 */
export interface SessionCapacityPin {
  windowTokens: number;
  inputCeilingTokens: number;
  source: 'reported' | 'manual' | 'catalog' | 'unresolved';
  provenance: string;
  actionable: boolean;
}

export interface SessionRecord {
  readonly id: string;
  /** CLI-reported session ID (from session_init event) */
  cliSessionId?: string;
  /** Canonical workspace path associated with this CLI session, when provider-scoped. */
  workingDirectory?: string;
  /** Stable workspace identity used to decide whether a CLI session can be resumed. */
  workspaceFingerprint?: string;
  readonly threadId: string;
  readonly catId: CatId;
  readonly userId: string;
  /** Chain sequence number (0-based) */
  readonly seq: number;
  status: SessionStatus;
  /** Latest context health snapshot after last invocation */
  contextHealth?: ContextHealth;
  /** #1208: active-session capacity is shrink-only until session rollover. */
  capacityPin?: SessionCapacityPin;
  /** Latest token usage snapshot (persisted for frontend display after reload) */
  lastUsage?: SessionUsageSnapshot;
  messageCount: number;
  /** Seal reason (Phase B). F225 adds 'cat_initiated_handoff' for 猫主动 handoff. */
  sealReason?: 'threshold' | 'manual' | 'error' | 'cat_initiated_handoff' | (string & {});
  /**
   * F225: 猫亲手写的五件套交接留言（typed，KD-4，非 continuityCapsule:unknown）。
   * approve 时 seal 前持久化；bootstrap always-keep 注入续接 session 第一眼（B2）。
   * 带 proposalId 让 commit point 可从 session 侧反推（KD-9 crash recovery）。
   */
  catHandoffNote?: CatHandoffNote;
  /** Lifetime compression telemetry. `null` means the historical total is unknown. */
  compressionCount: number | null;
  /** #1329 immutable strategy snapshot most recently applied at a managed invocation boundary. */
  appliedPolicy?: SessionPolicySnapshot;
  /** #1329 policy-local progress for the active hybrid revision. */
  hybridProgress?: HybridProgress;
  /** Structured collaboration control-flow state used across compact/seal/resume boundaries. */
  continuityCapsule?: unknown;
  /** F118 AC-C6: Consecutive restore failures for overflow circuit breaker */
  consecutiveRestoreFailures?: number;
  /**
   * F198 Bug #3 chainKey: stable conversation-level anchor.
   * For bg carrier: `bg:${threadId}:${catId}` — persists across daemon
   * rotation (the daemon forks a fresh sessionId UUID every `--bg --resume`
   * round, so cliSessionId is NOT a stable conversation identity).
   * For other providers (-p / codex / gemini): undefined (cliSessionId is
   * already stable per-conversation, no derivation needed).
   */
  chainKey?: string;
  /**
   * F198 Bug #3: latest fork sessionId emitted by the bg carrier (daemon
   * writes it to state.resumeSessionId after each `--bg --resume` turn).
   * Used as the next-round `--resume` target. bg-only — undefined for
   * other providers.
   */
  latestResumeSessionId?: string;
  readonly createdAt: number;
  updatedAt: number;
  sealedAt?: number;
}

/** Slim usage snapshot persisted per session (subset of full TokenUsage). */
export interface SessionUsageSnapshot {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  costUsd?: number;
}

export interface ContextHealth {
  /** Tokens used for context health. Check usedFrom before interpreting source semantics. */
  usedTokens: number;
  /** Total context window capacity (including output reserve). */
  windowTokens: number;
  /**
   * usedTokens / inputCeilingTokens (0.0 ~ 1.0).
   * #1208 denominator fix: denominator is the effective input ceiling
   * (windowTokens - outputReserve), NOT the raw windowTokens.
   * This is correct because usedTokens measures input tokens consumed,
   * and the actionable budget for lifecycle decisions is the input ceiling.
   */
  fillRatio: number;
  /** exact = carrier-authoritative usage; approx is retained for legacy records. */
  source: 'exact' | 'approx';
  /** Usage field that fed usedTokens. Older records may omit it. */
  usedFrom?: 'context' | 'last_turn' | 'input' | 'total';
  measuredAt: number;
}

/**
 * F225 软层: cat-facing DERIVED hint, emitted only when the session strategy
 * enters the warn band (between warn and action thresholds). Distinct from the
 * raw {@link ContextHealth} telemetry — this nudges the cat to run the
 * `context-self-management` 3-axis self-check (line vs tree / breakpoint? /
 * compressed how many times?). It does NOT say "handoff now": handoff-vs-compress
 * is the cat's judgment, not a binary trigger.
 */
export interface ContextManagementHint {
  /** Only 'warn' is emitted today (the band before auto-seal kicks in). */
  severity: 'warn';
  /**
   * How much to trust the fill ratio, by CONFIDENCE TIER (not by cat family):
   * - `exact_token`  — CLI-reported exact token usage → trust the %.
   * - `approx_token` — token-based but fallback window / aggregate → weak signal.
   * - `bytes_health` — trajectory bytes, not tokens (e.g. Antigravity) → weak signal.
   * - `unavailable`  — no reliable fill signal (e.g. Gemini cumulative-only) →
   *   cat leans purely on the breakpoint + drift self-check axes.
   * Current producers emit `exact_token`/`approx_token`; `bytes_health`/`unavailable`
   * are the documented homes for when per-runtime health computation feeds them.
   */
  fillConfidence: 'exact_token' | 'approx_token' | 'bytes_health' | 'unavailable';
  /**
   * Times this session was compressed when full lifetime observation exists.
   * `null` is unknown and must not be interpreted as observed zero.
   */
  compressionCount: number | null;
}

export interface ContextHealthConfig {
  /** Warning threshold — frontend shows yellow */
  warnThreshold: number;
  /** Seal threshold — triggers auto-seal (Phase B) */
  sealThreshold: number;
  /** Extra budget per turn (tokens) to prevent single-turn overflow */
  turnBudget?: number;
  /** Safety margin above turnBudget (tokens) */
  safetyMargin?: number;
}

export interface SealResult {
  /** Whether the seal request was accepted */
  accepted: boolean;
  /** Current status after the attempt */
  status: SessionStatus;
  /** Session ID that was sealed (if accepted) */
  sessionId?: string;
  /** Stable reason for a rejected transition. */
  rejectionReason?: 'not_found' | 'not_active' | 'policy_revision_mismatch';
}

// ── F33: Session Strategy Configurability ──

/** Session lifecycle strategy type */
export type SessionStrategy = 'handoff' | 'compress' | 'hybrid';

/** Per-cat session lifecycle strategy configuration */
export interface SessionStrategyConfig {
  /** Strategy type */
  strategy: SessionStrategy;
  /** Context health thresholds */
  thresholds: {
    /** Frontend warning (yellow) fillRatio */
    warn: number;
    /** Trigger strategy action fillRatio */
    action: number;
  };
  /** handoff strategy parameters */
  handoff?: {
    /** Attempt MEMORY.md dump before seal */
    preSealMemoryDump: boolean;
    /** Bootstrap injection depth */
    bootstrapDepth: 'extractive' | 'generative';
  };
  /** compress strategy parameters */
  compress?: {
    /** Max compressions (unlimited for compress; effective for hybrid) */
    maxCompressions?: number;
    /** Track context_health after compression */
    trackPostCompression: boolean;
  };
  /** hybrid-specific parameters (Phase 1: hook-capable providers only) */
  hybrid?: {
    /** Switch to handoff after N compressions */
    maxCompressions: number;
  };
  /** Per-turn token budget */
  turnBudget?: number;
  /** Safety margin above turnBudget */
  safetyMargin?: number;
}

/** Provenance of the policy selected for one managed invocation. */
export type SessionPolicySource =
  | 'runtime_override'
  | 'config_file'
  | 'breed_code'
  | 'provider_default'
  | 'global_default'
  | 'legacy_session_chain_false';

/** Stable machine-readable reasons why a policy cannot execute at full fidelity. */
export type SessionExecutionReason =
  | 'effective_input_ceiling'
  | 'carrier_binding'
  | 'authoritative_usage'
  | 'session_rotation'
  | 'continuity_bootstrap'
  | 'compression_signal'
  | 'managed_invocation_boundary';

/** Capability is a status projection; it never substitutes another policy. */
export interface SessionExecutionStatus {
  status: 'active' | 'degraded' | 'unavailable';
  missingCapabilities: SessionExecutionReason[];
}

/** Immutable policy and execution evidence used by one managed invocation. */
export interface SessionPolicySnapshot {
  config: SessionStrategyConfig;
  source: SessionPolicySource;
  revision: string;
  changedAt: number;
  execution: SessionExecutionStatus;
}

/** Policy-local progress for one hybrid revision; distinct from lifetime telemetry. */
export interface HybridProgress {
  policyRevision: string;
  observedCount: number;
  startedAt: string;
}

/** Seal reason for strategy-driven actions */
export type SealReason = 'threshold' | 'budget_exhausted' | 'max_compressions' | 'manual' | 'error' | (string & {});

/** Strategy action returned by shouldTakeAction() */
export type StrategyAction =
  | { type: 'none' }
  | { type: 'warn' }
  | { type: 'seal'; reason: SealReason }
  | { type: 'allow_compress' }
  | { type: 'seal_after_compress'; reason: SealReason };
