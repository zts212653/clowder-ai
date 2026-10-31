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
  TraceEvent,
  TraceEventDisabled,
  TraceEventFired,
  TraceEventSkipped,
} from '@cat-cafe/shared';
import type { HookRegistry } from './HookRegistry.js';

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
   * Render content for a fired hook: CONTENT passthrough → template → fallback.
   * Returns null if no template found (caller emits template_missing trace).
   */
  private renderContent(hook: RegisteredHook, templateId: string, vars: Record<string, string>): string | null {
    // Resolver-produced content passthrough: when the resolver provides a CONTENT
    // var, it signals that the final rendered content is already assembled
    // (e.g., S6 breed-specific workflow triggers, S13 pre-rendered MCP tools
    // section). Skip template rendering — the template file may be a data source
    // (YAML) or expect vars that only the legacy path provides.
    if (vars.CONTENT) return vars.CONTENT;
    return this.renderer(templateId, vars) ?? this.renderFromTemplatePath(hook, vars);
  }

  /**
   * Execute all hooks for a stage in manifest order.
   * Each hook: enabled check → resolve → render → patch + trace.
   *
   * Uses manifest baseline for enabled/version. Runtime overrides
   * (HookOverrideStore) will be added in a separate PR.
   */
  executeStage(stage: HookStage, input: AssemblerInput): PipelineResult {
    const hooks = this.registry.getStageHooks(stage);
    const patches: PromptPatch[] = [];
    const events: TraceEvent[] = [];

    for (const hook of hooks) {
      const hookId = hook.manifest.id;
      const ts = Date.now();

      // 1. Enabled check — manifest baseline
      if (!hook.manifest.enabled) {
        events.push({
          hookId,
          stage,
          timestamp: ts,
          status: 'disabled',
          disabledBy: 'manifest',
        } as TraceEventDisabled);
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

      // 3. Resolve template variant + render content
      const templateId = result.vars.TEMPLATE_VARIANT ?? hookId;
      const content = this.renderContent(hook, templateId, result.vars);
      if (!content) {
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

      // 4. Produce patch + trace (manifest version)
      patches.push({ hookId, content, order: hook.manifest.order });
      events.push({
        hookId,
        stage,
        timestamp: ts,
        status: 'fired',
        version: hook.manifest.version,
        contentHash: hashContent(content),
        tokenEstimate: estimateTokens(content),
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
