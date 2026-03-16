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

export type SessionStatus = 'active' | 'sealing' | 'sealed';

export interface SessionRecord {
  readonly id: string;
  /** CLI-reported session ID (from session_init event) */
  cliSessionId: string;
  readonly threadId: string;
  readonly catId: CatId;
  readonly userId: string;
  /** Chain sequence number (0-based) */
  readonly seq: number;
  status: SessionStatus;
  /** Latest context health snapshot after last invocation */
  contextHealth?: ContextHealth;
  /** Latest token usage snapshot (persisted for frontend display after reload) */
  lastUsage?: SessionUsageSnapshot;
  messageCount: number;
  /** Seal reason (Phase B) */
  sealReason?: 'threshold' | 'manual' | 'error' | (string & {});
  /** F33: Number of CLI compressions in this session (hybrid strategy) */
  compressionCount?: number;
  /** F118 AC-C6: Consecutive restore failures for overflow circuit breaker */
  consecutiveRestoreFailures?: number;
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
  /** Current used tokens (= inputTokens from last invocation) */
  usedTokens: number;
  /** Total context window capacity */
  windowTokens: number;
  /** usedTokens / windowTokens (0.0 ~ 1.0) */
  fillRatio: number;
  /** exact = CLI reported; approx = hardcoded fallback */
  source: 'exact' | 'approx';
  measuredAt: number;
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

/** Seal reason for strategy-driven actions */
export type SealReason = 'threshold' | 'budget_exhausted' | 'max_compressions' | 'manual' | 'error' | (string & {});

/** Strategy action returned by shouldTakeAction() */
export type StrategyAction =
  | { type: 'none' }
  | { type: 'warn' }
  | { type: 'seal'; reason: SealReason }
  | { type: 'allow_compress' }
  | { type: 'seal_after_compress'; reason: SealReason };
