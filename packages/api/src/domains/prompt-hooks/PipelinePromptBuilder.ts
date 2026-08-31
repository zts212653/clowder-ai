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
 * Pipeline output equals legacy output (AC-P2-14 zero behavior change).
 * Runtime overrides injected via setOverrideStore() at bootstrap (PR3).
 */

import { join } from 'node:path';
import type { AssemblerInput, CatId } from '@cat-cafe/shared';
import { findMonorepoRoot } from '../../utils/monorepo-root.js';
import { renderSegment } from '../cats/services/context/prompt-template-loader.js';
import type { InvocationContext, StaticIdentityOptions } from '../cats/services/context/SystemPromptBuilder.js';
import { buildConciergePromptLines } from '../concierge/ConciergePromptSection.js';
import { assembleForSession, assembleForTurn } from './assemble-bridge.js';
import type { HookOverrideStore } from './HookOverrideStore.js';
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
// Override store wiring (PR3: HookOverrideStore → HookRegistry snapshot)
// ---------------------------------------------------------------------------

let cachedOverrideStore: HookOverrideStore | null = null;

/**
 * Set the override store reference (called once at bootstrap).
 * The store is used by `refreshOverrideSnapshot()` to load per-workspace
 * overrides into the registry before each prompt build.
 */
export function setOverrideStore(store: HookOverrideStore): void {
  cachedOverrideStore = store;
}

/**
 * Load the current override snapshot from Redis and inject it into the registry.
 * Must be called (await) before any synchronous pipeline execution — the registry
 * resolves overrides synchronously from the snapshot, so it must be pre-loaded.
 *
 * Forces lazy pipeline init if needed (cold-start: registry may not exist yet
 * when this is called before the first buildStaticIdentity).
 *
 * No-ops gracefully if no store is configured (e.g., Redis unavailable).
 */
export async function refreshOverrideSnapshot(workspaceId?: string): Promise<void> {
  if (!cachedOverrideStore) return;
  // Ensure pipeline singleton is initialized — getPipeline() is idempotent,
  // but on cold start cachedRegistry is null until first getPipeline() call.
  // Without this, the first invocation's refreshOverrideSnapshot() no-ops
  // and the first prompt build misses all overrides.
  if (!cachedRegistry) getPipeline();
  const snapshot = await cachedOverrideStore.loadSnapshot(workspaceId);
  cachedRegistry!.setOverrideSnapshot(snapshot);
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
 * Equivalent to legacy `buildStaticIdentity()`.
 *
 * Pipeline runs ALL session-init hooks (S+L+B+C) for full trace coverage,
 * but prompt output is scoped to S-prefix hooks only (matching legacy behavior).
 * Full PipelineResult available via `.trace` for observability.
 *
 * @returns Assembled prompt string + full trace result.
 */
export function buildStaticIdentityViaHookPipeline(catId: CatId, options?: StaticIdentityOptions): string {
  const { prompt, trace } = buildStaticIdentityViaHookPipelineWithTrace(catId, options);
  // AC-P2-8: capture for invocation-layer persistence.
  // #839: capture ALL hooks (L+S+B+C) for full pipeline observability.
  // Prompt output is still S-scoped (below), but trace records every hook
  // that fired — per-hook segments are execution truth, not delivery truth.
  capturedSessionTrace = trace;

  if (options?.annotateSegments) {
    const registry = getCachedRegistry();
    // Emit markers for ALL S-prefix hooks (fired → with content, skipped/disabled → empty marker = absent).
    // This matches legacy buildStaticIdentity's `mark()` behavior for parseAnnotatedSegments.
    const patchMap = new Map(trace.patches.filter((p) => SCOPE_S.test(p.hookId)).map((p) => [p.hookId, p.content]));
    const scopedEvents = trace.events.filter((ev) => SCOPE_S.test(ev.hookId));
    return scopedEvents
      .map((ev) => {
        const hook = registry?.getHook(ev.hookId);
        const name = hook?.manifest.name ?? ev.hookId;
        const content = patchMap.get(ev.hookId);
        return content ? `── [${ev.hookId}] ${name} ──\n${content}` : `── [${ev.hookId}] ${name} ──`;
      })
      .join('\n\n');
  }

  return prompt;
}

/** Same as buildStaticIdentityViaHookPipeline but also returns full trace. */
export function buildStaticIdentityViaHookPipelineWithTrace(
  catId: CatId,
  options?: StaticIdentityOptions,
): { prompt: string; trace: PipelineResult } {
  const input = assembleForSession(catId, options);
  const pipeline = getPipeline();
  const trace = pipeline.executeStage('session-init', input);
  // Scope to S-prefix hooks only (legacy buildStaticIdentity scope)
  const scopedPatches = trace.patches.filter((p) => SCOPE_S.test(p.hookId));
  const prompt = HookPipeline.assemblePatches(scopedPatches);
  return { prompt, trace };
}

/**
 * Build per-turn prompt via HookPipeline.
 * Equivalent to legacy `buildInvocationContext()`.
 *
 * Pipeline runs ALL per-turn hooks (D+R+N) for full trace coverage,
 * but prompt output is scoped to D-prefix hooks only (matching legacy behavior).
 *
 * @returns Assembled prompt string from D-prefix per-turn hooks.
 */
export function buildInvocationContextViaHookPipeline(context: InvocationContext): string {
  const { prompt, trace } = buildInvocationContextViaHookPipelineWithTrace(context);
  // AC-P2-8: capture for invocation-layer persistence.
  // #839: capture ALL hooks (D+R+N) for full pipeline observability.
  // Prompt output is still D-scoped (below), but trace records every hook
  // that fired — per-hook segments are execution truth, not delivery truth.
  capturedTurnTrace = trace;

  // F229: Concierge duty section — not yet a pipeline hook.
  // Legacy SystemPromptBuilder places concierge between D17 and D18 (before D21
  // trailing anchor). Splice into patches at the correct position to preserve
  // ordering for AC-P2-14 zero-behavior-change.
  if (context.threadKind === 'concierge' && context.conciergeConfig) {
    const conciergeLines = buildConciergePromptLines(context.conciergeConfig, context.threadId);
    if (conciergeLines.length > 0) {
      const scopedPatches = [...trace.patches.filter((p) => SCOPE_D.test(p.hookId))];
      // Insert before D18 (order 1800) — matches legacy position after D17 (order 1700)
      const d18Idx = scopedPatches.findIndex((p) => p.hookId === 'D18');
      const insertIdx = d18Idx >= 0 ? d18Idx : scopedPatches.length;
      scopedPatches.splice(insertIdx, 0, {
        hookId: 'concierge-f229',
        content: conciergeLines.join('\n'),
        order: 1750,
      });
      return HookPipeline.assemblePatches(scopedPatches);
    }
  }

  return prompt;
}

/** Same as buildInvocationContextViaHookPipeline but also returns full trace. */
export function buildInvocationContextViaHookPipelineWithTrace(context: InvocationContext): {
  prompt: string;
  trace: PipelineResult;
} {
  const input = assembleForTurn(context);
  const pipeline = getPipeline();
  const trace = pipeline.executeStage('per-turn', input);
  // Scope to D-prefix hooks only (legacy buildInvocationContext scope)
  const scopedPatches = trace.patches.filter((p) => SCOPE_D.test(p.hookId));
  const prompt = HookPipeline.assemblePatches(scopedPatches);
  return { prompt, trace };
}

/**
 * Build full system prompt (session-init + per-turn) via HookPipeline.
 * Equivalent to legacy `buildSystemPrompt()`.
 *
 * Unlike the scoped builders above, this produces the FULL unfiltered pipeline
 * output — all 46 hooks. Use when the pipeline IS the single source (future).
 *
 * @returns Combined prompt string with trace results for observability.
 */
export function buildSystemPromptViaHookPipeline(context: InvocationContext): {
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

  const sessionTrace = pipeline.executeStage('session-init', sessionInput);
  const turnTrace = pipeline.executeStage('per-turn', turnInput);

  const sessionOutput = HookPipeline.assemblePatches(sessionTrace.patches);
  const turnOutput = HookPipeline.assemblePatches(turnTrace.patches);
  const prompt = [sessionOutput, turnOutput].filter(Boolean).join('\n\n');

  return { prompt, sessionInput, turnInput, sessionTrace, turnTrace };
}
