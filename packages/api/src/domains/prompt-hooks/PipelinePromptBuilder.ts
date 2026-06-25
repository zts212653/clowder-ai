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
import { HookPipeline } from './HookPipeline.js';
import { HookRegistry } from './HookRegistry.js';
import { RESOLVER_MAP } from './resolvers/index.js';

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
// Pipeline-backed builders (AC-P2-6)
// ---------------------------------------------------------------------------

/**
 * Build session-init prompt via HookPipeline.
 * Equivalent to legacy `buildStaticIdentity()` when no overrides active.
 *
 * @param overrides Optional pre-resolved override map (from HookOverrideStore).
 * @returns Assembled prompt string from all fired session-init hooks.
 */
export function buildStaticIdentityViaHookPipeline(
  catId: CatId,
  options?: StaticIdentityOptions,
  overrides?: ReadonlyMap<string, EffectiveHookState>,
): string {
  const input = assembleForSession(catId, options);
  const pipeline = getPipeline();
  const result = pipeline.executeStage('session-init', input, overrides);
  return HookPipeline.assemblePatches(result.patches);
}

/**
 * Build per-turn prompt via HookPipeline.
 * Equivalent to legacy `buildInvocationContext()` when no overrides active.
 *
 * @param overrides Optional pre-resolved override map (from HookOverrideStore).
 * @returns Assembled prompt string from all fired per-turn hooks.
 */
export function buildInvocationContextViaHookPipeline(
  context: InvocationContext,
  overrides?: ReadonlyMap<string, EffectiveHookState>,
): string {
  const input = assembleForTurn(context);
  const pipeline = getPipeline();
  const result = pipeline.executeStage('per-turn', input, overrides);
  return HookPipeline.assemblePatches(result.patches);
}

/**
 * Build full system prompt (session-init + per-turn) via HookPipeline.
 * Equivalent to legacy `buildSystemPrompt()` when no overrides active.
 *
 * @returns Combined prompt string with trace results for observability.
 */
export function buildSystemPromptViaHookPipeline(
  context: InvocationContext,
  overrides?: ReadonlyMap<string, EffectiveHookState>,
): { prompt: string; sessionInput: AssemblerInput; turnInput: AssemblerInput } {
  const sessionInput = assembleForSession(context.catId, {
    mcpAvailable: context.mcpAvailable,
    packBlocks: context.packBlocks,
  });
  const turnInput = assembleForTurn(context);
  const pipeline = getPipeline();

  const sessionResult = pipeline.executeStage('session-init', sessionInput, overrides);
  const turnResult = pipeline.executeStage('per-turn', turnInput, overrides);

  const sessionOutput = HookPipeline.assemblePatches(sessionResult.patches);
  const turnOutput = HookPipeline.assemblePatches(turnResult.patches);
  const prompt = [sessionOutput, turnOutput].filter(Boolean).join('\n\n');

  return { prompt, sessionInput, turnInput };
}
