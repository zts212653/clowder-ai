/**
 * Context Capacity Resolver
 * clowder-ai#1208: single source of truth for a member's effective context capacity.
 *
 * Resolution order (discovery):
 *   1. CLI-reported contextWindowSize (exact, from live session).
 *   2. Model catalog — known model capacity (e.g. opus 1M, GLM-5.2 1M).
 *   3. Provider last-resort default (e.g. OpenCode 128K for unknown models).
 *   4. Nothing → unresolved; lifecycle actions must fail closed and the UI shows the gap.
 *
 * Manual cap (CatConfig.contextWindow) is always honored as a ceiling on top of
 * the discovered value.  Users whose gateway caps below the model's native window
 * should set this field (e.g. OpenCode binding through a 128K gateway → set 128000).
 *
 * Effective input ceiling = effectiveWindow - outputReserve.  This is the shared
 * denominator used by prompt assembly, context health, and client-native window
 * settings.
 */

import { catRegistry } from '@cat-cafe/shared';
import { createModuleLogger } from '../infrastructure/logger.js';
import {
  getContextWindowFallback,
  OPENCODE_DEFAULT_CONTEXT_WINDOW,
  resolveContextWindow,
} from './context-window-sizes.js';

const log = createModuleLogger('context-capacity');

const DEFAULT_OUTPUT_RESERVE = 16_000;

/** Confidence tier for the resolved window. */
export type ContextCapacityConfidence =
  | 'exact' // CLI-reported usage for the live session
  | 'catalog' // Known model/provider catalog
  | 'default' // Provider last-resort default
  | 'manual' // User-supplied manual cap without discovery
  | 'unresolved'; // No usable source

export interface ResolvedContextCapacity {
  /** Effective context window tokens (total capacity). */
  readonly windowTokens: number;
  /** Tokens available for input after output/safety reserve. */
  readonly inputCeilingTokens: number;
  /** How the window was determined. */
  readonly source: ContextCapacityConfidence;
  /** Human-readable provenance string for UI/debug. */
  readonly provenance: string;
  /** Whether the value is authoritative enough for automatic handoff/compress. */
  readonly actionable: boolean;
}

export interface ResolveCapacityOptions {
  catId: string;
  /** CLI-reported window size, if any. */
  reportedWindowSize?: number | undefined;
  /** Effective model name for catalog lookups. */
  model?: string | undefined;
  /** Client/provider id for provider-specific defaults. */
  provider?: string | undefined;
}

/**
 * Get the member's manually-configured context window cap, if any.
 * Returns the explicit cap (positive integer) or undefined (Auto mode).
 *
 * Compat: when top-level `contextWindow` is absent, reads legacy `cli.contextWindow`
 * as a Manual cap. Next canonical save writes the top-level field.
 */
export function getMemberWindowCap(catId: string): number | undefined {
  const config = catRegistry.tryGet(catId)?.config;
  if (!config) return undefined;
  // Top-level contextWindow is the canonical source (#1208).
  if (config.contextWindow != null) return config.contextWindow;
  // Legacy compat: cli.contextWindow written by older catalogs.
  const legacyCli = config.cli?.contextWindow;
  return legacyCli != null && legacyCli > 0 ? legacyCli : undefined;
}

/**
 * Get the output reserve for deriving input ceiling from the window.
 * Internal derivation only — never exposed to users (clowder-ai#1208).
 */
export function getMemberOutputReserve(_catId: string): number {
  return DEFAULT_OUTPUT_RESERVE;
}

/**
 * Resolve the member's effective context capacity for the current invocation.
 *
 * Rules:
 * - Manual cap is always honored as the ceiling.  If discovery exceeds it, the
 *   effective value is the cap and provenance reflects "capped".
 * - Auto without discovery returns the manual cap if present; otherwise unresolved.
 * - Discovery values are never silently expanded above a manual cap.
 * - When nothing is available, returns unresolved with actionable=false.
 */
export function resolveContextCapacity(options: ResolveCapacityOptions): ResolvedContextCapacity {
  const { catId, reportedWindowSize, model, provider } = options;
  const manualCap = getMemberWindowCap(catId);

  let discovered: number | undefined;
  let source: ContextCapacityConfidence = 'unresolved';
  let provenance = 'No discovery source available';

  // Step 1: CLI-reported window (exact, from live session)
  if (reportedWindowSize != null && Number.isFinite(reportedWindowSize) && reportedWindowSize > 0) {
    discovered = resolveContextWindow(reportedWindowSize, model ?? '');
    if (discovered != null) {
      source = 'exact';
      provenance = `CLI reported ${discovered.toLocaleString()} tokens`;
    }
  }

  // Step 2: Model catalog — use the known model capacity when available.
  // This correctly resolves models like GLM-5.2 (1M) even through OpenCode,
  // because those bindings expose the model's native window.
  if (discovered == null && model) {
    discovered = getContextWindowFallback(model);
    if (discovered != null) {
      source = 'catalog';
      provenance = `Model catalog (${model}) → ${discovered.toLocaleString()} tokens`;
    }
  }

  // Step 3: OpenCode last-resort default — only when the model is NOT in the
  // catalog (unknown/custom models). Users whose OpenCode binding caps below the
  // catalog value should set `contextWindow` (Manual mode) on their member config.
  if (discovered == null && provider === 'opencode') {
    discovered = OPENCODE_DEFAULT_CONTEXT_WINDOW;
    source = 'default';
    provenance = `OpenCode default (unknown model) → ${discovered.toLocaleString()} tokens`;
  }

  let windowTokens: number;
  if (manualCap != null) {
    if (discovered != null) {
      windowTokens = Math.min(discovered, manualCap);
      if (windowTokens < discovered) {
        provenance = `${provenance}; capped to member limit ${manualCap.toLocaleString()}`;
      } else {
        provenance = `${provenance}; member limit ${manualCap.toLocaleString()} not binding`;
      }
    } else {
      windowTokens = manualCap;
      source = 'manual';
      provenance = `Member manual cap → ${manualCap.toLocaleString()} tokens`;
    }
  } else if (discovered != null) {
    windowTokens = discovered;
  } else {
    return {
      windowTokens: 0,
      inputCeilingTokens: 0,
      source: 'unresolved',
      provenance,
      actionable: false,
    };
  }

  const outputReserve = getMemberOutputReserve(catId);
  const inputCeilingTokens = Math.max(0, windowTokens - outputReserve);

  log.debug({ catId, windowTokens, inputCeilingTokens, source, provenance }, 'resolved context capacity');

  return {
    windowTokens,
    inputCeilingTokens,
    source,
    provenance,
    actionable: source !== 'unresolved',
  };
}

/**
 * Convenience: resolve capacity and return just the effective window tokens.
 * Returns `undefined` when unresolved.
 */
export function resolveEffectiveWindowTokens(options: ResolveCapacityOptions): number | undefined {
  const capacity = resolveContextCapacity(options);
  return capacity.actionable ? capacity.windowTokens : undefined;
}

/**
 * Prompt-assembly limits derived from the resolved context capacity.
 * Replaces the legacy 4-field ContextBudget.  All consumers (serial, parallel,
 * SessionSealer, DegradationPolicy) read from this shape.
 */
export interface PromptAssemblyBudget {
  /** Total input token ceiling (window - output reserve). */
  readonly maxPromptTokens: number;
  /** Max tokens for historical context (input ceiling × 0.85). */
  readonly maxHistoryContextTokens: number;
  /** Max historical messages to include (scales sub-linearly with window). */
  readonly maxMessages: number;
  /** Character truncation per message. */
  readonly maxContentLengthPerMsg: number;
}

/**
 * Derive prompt-assembly limits from the effective input ceiling.
 *
 * The legacy four context-budget knobs are retired; this function produces
 * sensible defaults based on the member's capacity policy.  Callers may still
 * apply Smart Window / unread-message selection on top of these numbers.
 */
export function derivePromptAssemblyBudget(inputCeilingTokens: number): PromptAssemblyBudget {
  // Reserve ~10% of the input ceiling for system prompt + current turn + safety.
  const maxHistoryContextTokens = Math.floor(inputCeilingTokens * 0.85);
  const maxPromptTokens = inputCeilingTokens;
  // Message count scales sub-linearly with window to avoid tiny-message flooding.
  const maxMessages = Math.max(50, Math.min(500, Math.floor(inputCeilingTokens / 1_500)));
  // Character truncation limit: keep messages readable but allow long outputs.
  const maxContentLengthPerMsg = 100_000;
  return {
    maxPromptTokens,
    maxHistoryContextTokens,
    maxMessages,
    maxContentLengthPerMsg,
  };
}
