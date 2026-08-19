/**
 * Context Capacity Resolver
 * clowder-ai#1208: one member setting, read once for each invocation.
 *
 * Manual mode is an operator cap, not a claim that the provider supports that
 * size. A trusted carrier report therefore limits a larger manual value; an
 * unproven model-catalog entry never does.
 *
 * Auto mode uses a carrier report when one is available, otherwise the model
 * catalog. Unknown bindings remain unresolved instead of receiving a guessed
 * provider-wide default.
 */

import { type CatConfig, catRegistry } from '@cat-cafe/shared';
import { createModuleLogger } from '../infrastructure/logger.js';
import { getContextWindowFallback, resolveContextWindow } from './context-window-sizes.js';

const log = createModuleLogger('context-capacity');
const DEFAULT_OUTPUT_RESERVE = 16_000;
const UNRESOLVED_PROMPT_INPUT_CEILING = 100_000;

export type ContextCapacitySource = 'reported' | 'manual' | 'catalog' | 'unresolved';

export interface ResolvedContextCapacity {
  /** Effective context window tokens (total capacity). */
  readonly windowTokens: number;
  /** Tokens available for input after output/safety reserve. */
  readonly inputCeilingTokens: number;
  /** Where the effective value came from. */
  readonly source: ContextCapacitySource;
  /** Human-readable source description for Hub/debug output. */
  readonly provenance: string;
  /** Whether the denominator is explicit enough for automatic lifecycle actions. */
  readonly actionable: boolean;
}

export interface ResolveCapacityOptions {
  catId: string;
  /**
   * Factory/snapshot-time member value when the caller owns the canonical config.
   * `null` means the caller captured Auto mode and prevents a later registry read.
   */
  memberWindowTokens?: number | null | undefined;
  /** Trusted carrier-reported window size. */
  reportedWindowSize?: number | undefined;
  /** Effective model name for Auto-mode catalog lookup. */
  model?: string | undefined;
}

/**
 * Return the member's explicit context window, if any.
 *
 * Compatibility: a legacy `cli.contextWindow` is read only when the canonical
 * top-level value is absent. The next catalog save promotes and strips it.
 */
export function getConfiguredMemberWindowSetting(config: Pick<CatConfig, 'contextWindow' | 'cli'>): number | undefined {
  if (config.contextWindow != null) return config.contextWindow;
  const legacyCli = (config.cli as { contextWindow?: number } | undefined)?.contextWindow;
  return legacyCli != null && legacyCli > 0 ? legacyCli : undefined;
}

export function getMemberWindowSetting(catId: string): number | undefined {
  const config = catRegistry.tryGet(catId)?.config;
  return config ? getConfiguredMemberWindowSetting(config) : undefined;
}

/** Internal derivation only; this is not a user-facing prompt-policy knob. */
export function getMemberOutputReserve(_catId: string): number {
  return DEFAULT_OUTPUT_RESERVE;
}

/** Resolve the effective capacity for one member invocation. */
export function resolveContextCapacity(options: ResolveCapacityOptions): ResolvedContextCapacity {
  const { catId, reportedWindowSize, model } = options;
  const manualWindow =
    options.memberWindowTokens === undefined
      ? getMemberWindowSetting(catId)
      : (options.memberWindowTokens ?? undefined);

  let windowTokens = 0;
  let source: ContextCapacitySource = 'unresolved';
  let provenance = 'No manual value, carrier report, or model catalog entry is available';
  let actionable = false;
  const reported =
    reportedWindowSize != null && Number.isFinite(reportedWindowSize) && reportedWindowSize > 0
      ? resolveContextWindow(reportedWindowSize, model ?? '')
      : undefined;

  if (
    manualWindow != null &&
    Number.isFinite(manualWindow) &&
    manualWindow > 0 &&
    reported != null &&
    reported < manualWindow
  ) {
    windowTokens = reported;
    source = 'reported';
    provenance = `Carrier reported ${reported.toLocaleString()} tokens; limits member cap ${manualWindow.toLocaleString()}`;
    actionable = true;
  } else if (manualWindow != null && Number.isFinite(manualWindow) && manualWindow > 0) {
    windowTokens = manualWindow;
    source = 'manual';
    provenance =
      reported != null
        ? `Member context window → ${manualWindow.toLocaleString()} tokens; within carrier limit ${reported.toLocaleString()}`
        : `Member context window → ${manualWindow.toLocaleString()} tokens`;
    actionable = true;
  } else if (reported != null) {
    windowTokens = reported;
    source = 'reported';
    provenance = `Carrier reported ${reported.toLocaleString()} tokens`;
    actionable = true;
  } else if (model) {
    const catalogWindow = getContextWindowFallback(model);
    if (catalogWindow != null) {
      windowTokens = catalogWindow;
      source = 'catalog';
      provenance = `Model catalog (${model}) → ${catalogWindow.toLocaleString()} tokens`;
    }
  }

  const inputCeilingTokens = Math.max(0, windowTokens - getMemberOutputReserve(catId));
  const result: ResolvedContextCapacity = {
    windowTokens,
    inputCeilingTokens,
    source,
    provenance,
    actionable,
  };

  log.debug({ catId, ...result }, 'resolved invocation context capacity');
  return result;
}

/** Return undefined only when Auto mode has no report or catalog entry. */
export function resolveEffectiveWindowTokens(options: ResolveCapacityOptions): number | undefined {
  const capacity = resolveContextCapacity(options);
  return capacity.source === 'unresolved' ? undefined : capacity.windowTokens;
}

/**
 * Prompt assembly must retain bounded history even when Auto mode cannot yet
 * resolve a lifecycle denominator. This conservative input ceiling is only a
 * truncation guard: it is not reported as model capacity and cannot trigger
 * automatic lifecycle actions or provider-native window controls.
 */
export function resolvePromptInputCeilingTokens(capacity: ResolvedContextCapacity): number {
  return capacity.source === 'unresolved' ? UNRESOLVED_PROMPT_INPUT_CEILING : capacity.inputCeilingTokens;
}

/** History receives a scalar share of the invocation-owned input ceiling. */
export function deriveHistoryContextTokenCeiling(inputCeilingTokens: number): number {
  return Math.floor(Math.max(0, inputCeilingTokens) * 0.85);
}

/**
 * Direct consumers that are not inside an invocation still need bounded,
 * non-empty history. Reuse the unresolved prompt guard without treating it as
 * model capacity or consulting mutable member configuration. Future direct
 * consumers should call this resolver instead of duplicating the 100k/85k
 * derivation.
 */
export function resolveUnboundHistoryContextTokenCeiling(): number {
  return deriveHistoryContextTokenCeiling(UNRESOLVED_PROMPT_INPUT_CEILING);
}
