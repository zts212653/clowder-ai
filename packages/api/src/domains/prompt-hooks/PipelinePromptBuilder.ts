/**
 * PipelinePromptBuilder — F237 Phase 2 (AC-P2-6)
 *
 * Pipeline-backed prompt builder: delegates to HookPipeline instead of
 * manual segment assembly in SystemPromptBuilder.
 *
 * Provides the same public API shape (catId/options → string) so routing
 * can switch from legacy buildStaticIdentity/buildInvocationContext to
 * pipeline versions without changing call structure.
 *
 * Lazy-initializes a singleton HookPipeline (scan-once, reuse across calls).
 * Override resolution is optional — when no overrides are active, pipeline
 * output equals legacy output (AC-P2-14 zero behavior change).
 */

import { join } from 'node:path';
import type { AssemblerInput, CatId, EffectiveHookState } from '@cat-cafe/shared';
import { findMonorepoRoot } from '../../utils/monorepo-root.js';
import { renderSegment } from '../cats/services/context/prompt-template-loader.js';
import type { InvocationContext, StaticIdentityOptions } from '../cats/services/context/SystemPromptBuilder.js';
import { assembleForSession, assembleForTurn } from './assemble-bridge.js';
import { HookPipeline, type PipelineResult } from './HookPipeline.js';
import { HookRegistry } from './HookRegistry.js';
import { RESOLVER_MAP } from './resolvers/index.js';

// ---------------------------------------------------------------------------
// Scope filters — map legacy builder functions to their hook scope.
//
// The pipeline executes ALL hooks for a stage (producing full trace events),
// but prompt output is filtered to match legacy scope for backward compat.
//
// Legacy architecture splits 46 hooks across multiple injection points:
//   buildStaticIdentity → S1-S13 only
//   buildInvocationContext → D1-D21 only
//   L0 compiler → L1-L7 (separate channel for native providers)
//   route-serial/parallel → R1-R2
//   route-helpers → N1
//   SessionBootstrap → B1
//   McpPromptInjector → C1
//
// During migration, each legacy function delegates to the pipeline but filters
// to its own scope. After full migration, filters are removed.
// ---------------------------------------------------------------------------

const SCOPE_S = /^S\d/; // S1-S13: buildStaticIdentity
const SCOPE_D = /^D\d/; // D1-D21: buildInvocationContext

// ---------------------------------------------------------------------------
// Singleton pipeline (lazy init on first call)
// ---------------------------------------------------------------------------

let cachedRegistry: HookRegistry | null = null;
let cachedPipeline: HookPipeline | null = null;

function getPipeline(): HookPipeline {
  if (cachedPipeline) return cachedPipeline;

  const root = findMonorepoRoot();
  const hooksDir = join(root, 'assets', 'prompt-hooks');
  const templatesDir = join(root, 'assets', 'prompt-templates');

  cachedRegistry = new HookRegistry(hooksDir, templatesDir);
  cachedRegistry.scan();
  cachedPipeline = new HookPipeline(cachedRegistry, RESOLVER_MAP, renderSegment);
  return cachedPipeline;
}

/** Exposed for testing: reset singleton so next call re-scans. */
export function resetPipelineSingleton(): void {
  cachedRegistry = null;
  cachedPipeline = null;
}

/** Exposed for testing: access the cached registry (null if not initialized). */
export function getCachedRegistry(): HookRegistry | null {
  return cachedRegistry;
}

// ---------------------------------------------------------------------------
// Trace capture (AC-P2-8): last pipeline traces for invocation-layer persistence
// ---------------------------------------------------------------------------

let capturedSessionTrace: PipelineResult | null = null;
let capturedTurnTrace: PipelineResult | null = null;

/**
 * Retrieve and clear the most recently captured pipeline traces.
 * Called by the invocation layer (route-serial/parallel) after building
 * prompts to persist InjectionTraceSummary + Detail.
 *
 * Returns null if no traces were captured (e.g., legacy path or no build yet).
 * Clears the buffer after retrieval — call exactly once per invocation.
 */
export function drainCapturedTraces(): { session: PipelineResult | null; turn: PipelineResult | null } {
  const result = { session: capturedSessionTrace, turn: capturedTurnTrace };
  capturedSessionTrace = null;
  capturedTurnTrace = null;
  return result;
}

// ---------------------------------------------------------------------------
// Pipeline-backed builders (AC-P2-6)
// ---------------------------------------------------------------------------

/**
 * Build session-init prompt via HookPipeline.
 * Equivalent to legacy `buildStaticIdentity()` when no overrides active.
 *
 * Pipeline runs ALL session-init hooks (S+L+B+C) for full trace coverage,
 * but prompt output is scoped to S-prefix hooks only (matching legacy behavior).
 * Full PipelineResult available via `.trace` for observability.
 *
 * @param overrides Optional pre-resolved override map (from HookOverrideStore).
 * @returns Assembled prompt string + full trace result.
 */
export function buildStaticIdentityViaHookPipeline(
  catId: CatId,
  options?: StaticIdentityOptions,
  overrides?: ReadonlyMap<string, EffectiveHookState>,
): string {
  const { prompt, trace } = buildStaticIdentityViaHookPipelineWithTrace(catId, options, overrides);
  capturedSessionTrace = trace; // AC-P2-8: capture for invocation-layer persistence
  return prompt;
}

/** Same as buildStaticIdentityViaHookPipeline but also returns full trace. */
export function buildStaticIdentityViaHookPipelineWithTrace(
  catId: CatId,
  options?: StaticIdentityOptions,
  overrides?: ReadonlyMap<string, EffectiveHookState>,
): { prompt: string; trace: PipelineResult } {
  const input = assembleForSession(catId, options);
  const pipeline = getPipeline();
  const trace = pipeline.executeStage('session-init', input, overrides);
  // Scope to S-prefix hooks only (legacy buildStaticIdentity scope)
  const scopedPatches = trace.patches.filter((p) => SCOPE_S.test(p.hookId));
  const prompt = HookPipeline.assemblePatches(scopedPatches);
  return { prompt, trace };
}

/**
 * Build per-turn prompt via HookPipeline.
 * Equivalent to legacy `buildInvocationContext()` when no overrides active.
 *
 * Pipeline runs ALL per-turn hooks (D+R+N) for full trace coverage,
 * but prompt output is scoped to D-prefix hooks only (matching legacy behavior).
 *
 * @param overrides Optional pre-resolved override map (from HookOverrideStore).
 * @returns Assembled prompt string from D-prefix per-turn hooks.
 */
export function buildInvocationContextViaHookPipeline(
  context: InvocationContext,
  overrides?: ReadonlyMap<string, EffectiveHookState>,
): string {
  const { prompt, trace } = buildInvocationContextViaHookPipelineWithTrace(context, overrides);
  capturedTurnTrace = trace; // AC-P2-8: capture for invocation-layer persistence
  return prompt;
}

/** Same as buildInvocationContextViaHookPipeline but also returns full trace. */
export function buildInvocationContextViaHookPipelineWithTrace(
  context: InvocationContext,
  overrides?: ReadonlyMap<string, EffectiveHookState>,
): { prompt: string; trace: PipelineResult } {
  const input = assembleForTurn(context);
  const pipeline = getPipeline();
  const trace = pipeline.executeStage('per-turn', input, overrides);
  // Scope to D-prefix hooks only (legacy buildInvocationContext scope)
  const scopedPatches = trace.patches.filter((p) => SCOPE_D.test(p.hookId));
  const prompt = HookPipeline.assemblePatches(scopedPatches);
  return { prompt, trace };
}

/**
 * Build full system prompt (session-init + per-turn) via HookPipeline.
 * Equivalent to legacy `buildSystemPrompt()` when no overrides active.
 *
 * Unlike the scoped builders above, this produces the FULL unfiltered pipeline
 * output — all 46 hooks. Use when the pipeline IS the single source (future).
 *
 * @returns Combined prompt string with trace results for observability.
 */
export function buildSystemPromptViaHookPipeline(
  context: InvocationContext,
  overrides?: ReadonlyMap<string, EffectiveHookState>,
): {
  prompt: string;
  sessionInput: AssemblerInput;
  turnInput: AssemblerInput;
  sessionTrace: PipelineResult;
  turnTrace: PipelineResult;
} {
  const sessionInput = assembleForSession(context.catId, {
    mcpAvailable: context.mcpAvailable,
    packBlocks: context.packBlocks,
  });
  const turnInput = assembleForTurn(context);
  const pipeline = getPipeline();

  const sessionTrace = pipeline.executeStage('session-init', sessionInput, overrides);
  const turnTrace = pipeline.executeStage('per-turn', turnInput, overrides);

  const sessionOutput = HookPipeline.assemblePatches(sessionTrace.patches);
  const turnOutput = HookPipeline.assemblePatches(turnTrace.patches);
  const prompt = [sessionOutput, turnOutput].filter(Boolean).join('\n\n');

  return { prompt, sessionInput, turnInput, sessionTrace, turnTrace };
}
