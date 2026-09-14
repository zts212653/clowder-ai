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
// Scope filter for the still-split per-turn route assembly. Session-init is no
// longer filtered: F257 S5 makes its complete HookPipeline result the one prompt
// source for every provider, with native carriers differing only in transport.
// ---------------------------------------------------------------------------

const SCOPE_D = /^D\d/; // D1-D21: buildInvocationContext

// ---------------------------------------------------------------------------
// Singleton pipeline (lazy init on first call)
// ---------------------------------------------------------------------------

let cachedRegistry: HookRegistry | null = null;
let cachedPipeline: HookPipeline | null = null;

function getPipeline(): HookPipeline {
  if (cachedPipeline) return cachedPipeline;

  const root = findMonorepoRoot();
  // CAT_CAFE_PROMPT_HOOKS_DIR: scan hooks from another directory (isolated
  // acceptance stacks, regression tests that must not touch repository assets).
  const hooksDir = process.env.CAT_CAFE_PROMPT_HOOKS_DIR || join(root, 'assets', 'prompt-hooks');
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

/**
 * Shared registry accessor for readers outside the prompt hot path (Console
 * manifest, governance describers). It materialises the same singleton the
 * pipeline uses, so `resetPipelineSingleton()` after a governance `add` is
 * observed by every reader at once — no reader may keep a private scan cache.
 */
export function getOrCreateRegistry(): HookRegistry {
  getPipeline();
  const registry = cachedRegistry;
  if (!registry) throw new Error('hook_registry_unavailable');
  return registry;
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
 * Produces the complete session-init prompt (L+S+B+C) for every provider.
 * Native carriers receive these exact bytes through their system/developer
 * channel; other carriers receive them through the message-prepend channel.
 *
 * @returns Assembled prompt string + full trace result.
 */
export function buildStaticIdentityViaHookPipeline(catId: CatId, options?: StaticIdentityOptions): string {
  const { prompt, trace } = buildStaticIdentityViaHookPipelineWithTrace(catId, options);
  // AC-P2-8: capture for invocation-layer persistence.
  // Capture the exact result that produced the delivered session prompt.
  capturedSessionTrace = trace;

  if (options?.annotateSegments) {
    const registry = getCachedRegistry();
    const patchMap = new Map(trace.patches.map((p) => [p.hookId, p.content]));
    return trace.events
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
  const prompt = HookPipeline.assemblePatches(trace.patches);
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
 * output — all 47 hooks. Use when the pipeline IS the single source (future).
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
