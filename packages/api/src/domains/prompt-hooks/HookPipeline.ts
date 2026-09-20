/**
 * HookPipeline — F237 Phase 2-C
 *
 * Executes hooks for a given stage in manifest order, producing
 * PromptPatch[] (rendered content) + TraceEvent[] (observability).
 *
 * Execution per hook:
 * 1. Check enabled (baseline) → TraceEventDisabled if off
 * 2. Run resolver → TraceEventSkipped if condition false
 * 3. Resolve TEMPLATE_VARIANT (D7/D15 multi-template hooks)
 * 4. Render template with vars → PromptPatch + TraceEventFired
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import type {
  AssemblerInput,
  HookResolver,
  HookStage,
  PromptPatch,
  RegisteredHook,
  ResolveResult,
  SegmentContentSourceKind,
  TraceEvent,
  TraceEventDisabled,
  TraceEventFired,
  TraceEventSkipped,
} from '@cat-cafe/shared';
import type { HookRegistry } from './HookRegistry.js';
import { matchesHookCondition } from './hook-condition-policy.js';

// ---------------------------------------------------------------------------
// Pipeline result
// ---------------------------------------------------------------------------

export interface PipelineResult {
  /** Rendered content patches, one per fired hook, in order. */
  patches: PromptPatch[];
  /** Trace events for every hook in the stage (fired, skipped, or disabled). */
  events: TraceEvent[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** SHA-256 hash of content (first 16 hex chars for compact storage). */
export function hashContent(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex').slice(0, 16);
}

/**
 * Rough token estimate: ~4 chars per token for mixed CJK/English content.
 * Good enough for trace display — not for billing.
 */
export function estimateTokens(content: string): number {
  return Math.ceil(content.length / 4);
}

// ---------------------------------------------------------------------------
// Renderer interface (decoupled from prompt-template-loader for testability)
// ---------------------------------------------------------------------------

/**
 * Template renderer function signature.
 * Maps to renderSegment(segmentId, vars) from prompt-template-loader.
 * Returns rendered content or null if template missing.
 */
export type TemplateRenderer = (segmentId: string, vars: Record<string, string>) => string | null;

// ---------------------------------------------------------------------------
// HookPipeline
// ---------------------------------------------------------------------------

export class HookPipeline {
  constructor(
    private readonly registry: HookRegistry,
    private readonly resolvers: ReadonlyMap<string, HookResolver>,
    private readonly renderer: TemplateRenderer,
  ) {}

  /**
   * Fallback renderer: read co-located template from hook directory.
   * Used when the primary renderer (renderSegment) returns null because
   * the template isn't registered in TEMPLATE_FILES but exists on disk
   * in the hook's directory (e.g. B1, R1, R2).
   */
  private renderFromTemplatePath(hook: RegisteredHook, vars: Record<string, string>): string | null {
    if (!hook.templatePath || !existsSync(hook.templatePath)) return null;
    const raw = readFileSync(hook.templatePath, 'utf-8');
    // Strip HTML comments (same logic as prompt-template-loader.stripComments)
    const stripped = raw
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('<!--'))
      .join('\n')
      .trim();
    if (!stripped) return null;
    // Render {{VAR}} placeholders (same logic as prompt-template-loader.renderTemplate)
    return stripped.replace(/\{\{(\w+)\}\}/g, (match, key: string) => (key in vars ? vars[key] : match));
  }

  /**
   * Render content for a fired hook:
   *   1. Content override from HookOverrideStore (PR3) — highest priority
   *   2. CONTENT var passthrough from resolver
   *   3. Template rendering → fallback template
   * Returns null if no content source found (caller emits template_missing trace).
   */
  private renderContent(
    hook: RegisteredHook,
    templateId: string,
    vars: Record<string, string>,
  ): { content: string; sourceKind: SegmentContentSourceKind; sourceRef: string } | null {
    // PR3: content override takes precedence over all other sources
    const contentOverride = this.registry.getContentOverride(hook.manifest.id);
    if (contentOverride !== undefined) {
      return { content: contentOverride, sourceKind: 'override', sourceRef: hook.manifest.id };
    }

    // Resolver-produced content passthrough: when the resolver provides a CONTENT
    // var, it signals that the final rendered content is already assembled
    // (e.g., S6 breed-specific workflow triggers, S13 pre-rendered MCP tools
    // section). Skip template rendering — the template file may be a data source
    // (YAML) or expect vars that only the legacy path provides.
    if (vars.CONTENT) {
      return { content: vars.CONTENT, sourceKind: 'content-var', sourceRef: `${hook.manifest.id}:CONTENT` };
    }

    const rendered = this.renderer(templateId, vars);
    if (rendered) return { content: rendered, sourceKind: 'template', sourceRef: templateId };

    const fallback = this.renderFromTemplatePath(hook, vars);
    if (fallback) return { content: fallback, sourceKind: 'file-fallback', sourceRef: hook.templatePath };

    return null;
  }

  /**
   * Decide the gates that precede any resolver work, in priority order.
   *
   * A hook that is turned off stays `disabled` even when the route also shadows
   * it — "was never going to run" is the more precise fact. A route-owned exact
   * contract then shadows a conflicting generic hook for this turn only, and is
   * recorded as `skipped` rather than filtered out of the rendered text: the
   * evaluation ledger must not claim a segment fired when it never reached the
   * model.
   *
   * Returns the terminal trace event, or null when the hook may proceed.
   */
  private rejectBeforeResolve(hookId: string, stage: HookStage, ts: number, input: AssemblerInput): TraceEvent | null {
    if (!this.registry.isEnabled(hookId)) {
      return {
        hookId,
        stage,
        timestamp: ts,
        status: 'disabled',
        disabledBy: this.registry.getDisabledBySource(hookId),
      } as TraceEventDisabled;
    }
    if (input.suppressedHookIds?.includes(hookId)) {
      return {
        hookId,
        stage,
        timestamp: ts,
        status: 'skipped',
        reasonCode: 'route_suppressed',
        reason: input.hookSuppressionReason ?? 'shadowed by a route-owned exact contract',
      } as TraceEventSkipped;
    }
    return null;
  }

  /**
   * Execute all hooks for a stage in manifest order.
   * Each hook: pre-resolve gates → resolve → governed condition → render → patch + trace.
   *
   * The pre-resolve gates (see rejectBeforeResolve) cover registry.isEnabled(),
   * which resolves override snapshot → manifest baseline, and route-owned
   * shadowing. Content overrides from HookOverrideStore take precedence over
   * template rendering.
   */
  executeStage(stage: HookStage, input: AssemblerInput): PipelineResult {
    const hooks = this.registry.getStageHooks(stage);
    const patches: PromptPatch[] = [];
    const events: TraceEvent[] = [];

    for (const hook of hooks) {
      const hookId = hook.manifest.id;
      const ts = Date.now();

      // 1. Gates that need no resolver work: turned off, or shadowed by the route.
      const preResolveRejection = this.rejectBeforeResolve(hookId, stage, ts, input);
      if (preResolveRejection) {
        events.push(preResolveRejection);
        continue;
      }

      // 2. Resolve: run resolver or unconditional fire
      const resolver = this.resolvers.get(hookId);
      const result = resolver ? resolver.resolve(input) : ({ status: 'fired', vars: {} } as ResolveResult);

      if (result.status === 'skipped') {
        events.push({
          hookId,
          stage,
          timestamp: ts,
          status: 'skipped',
          reasonCode: result.reasonCode,
          reason: result.reason,
        } as TraceEventSkipped);
        continue;
      }

      // 3. A governed condition is an extra AND gate. Running it after the
      // built-in resolver preserves the canonical resolver reason when both
      // gates are false and never broadens the hook's injection surface.
      const condition = this.registry.getConditionOverride(hookId);
      if (condition && !matchesHookCondition(condition, input)) {
        events.push({
          hookId,
          stage,
          timestamp: ts,
          status: 'skipped',
          reasonCode: 'condition_override_not_matched',
          reason: `Governed condition '${condition.conditionRef}' did not match`,
        } as TraceEventSkipped);
        continue;
      }

      // 4. Resolve template variant + render content
      const templateId = result.vars.TEMPLATE_VARIANT ?? hookId;
      const rendered = this.renderContent(hook, templateId, result.vars);
      if (!rendered) {
        events.push({
          hookId,
          stage,
          timestamp: ts,
          status: 'skipped',
          reasonCode: 'template_missing',
          reason: `Template '${templateId}' not found`,
        } as TraceEventSkipped);
        continue;
      }

      // 5. Produce patch + trace (override version → manifest version)
      patches.push({ hookId, content: rendered.content, order: hook.manifest.order });
      events.push({
        hookId,
        stage,
        timestamp: ts,
        status: 'fired',
        version: this.registry.getActiveVersion(hookId),
        contentHash: hashContent(rendered.content),
        tokenEstimate: estimateTokens(rendered.content),
        // F257 Console 判据④：persist event-time rendered content + source provenance for replay.
        content: rendered.content,
        contentSourceKind: rendered.sourceKind,
        templateRef: rendered.sourceRef,
        templateVars: result.vars,
      } as TraceEventFired);
    }

    return { patches, events };
  }

  /**
   * Assemble patches into a single prompt string.
   * Patches are already in order (from executeStage).
   * Joins with double-newline between patches.
   */
  static assemblePatches(patches: readonly PromptPatch[]): string {
    return patches.map((p) => p.content).join('\n\n');
  }
}
