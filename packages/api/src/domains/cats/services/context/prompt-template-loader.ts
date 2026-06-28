/**
 * Prompt Template Loader (F237 Checkpoint B+C)
 *
 * Loads prompt injection segments from external template files in
 * assets/prompt-templates/ instead of inline TypeScript constants.
 *
 * Templates support:
 * - Simple {{VAR}} placeholder substitution
 * - .local overlay files for user customization (Checkpoint C)
 *
 * Overlay priority: .cat-cafe/prompt-overlays/{id}.local.{ext} > assets/prompt-templates/{id}.{ext}
 * Only segments with allowLocalOverride: true support overlays.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import YAML from 'yaml';
import { findMonorepoRoot } from '../../../../utils/monorepo-root.js';

// ── Path resolution ──────────────────────────────────────────

export const TEMPLATES_DIR = join(findMonorepoRoot(), 'assets', 'prompt-templates');
export const TEMPLATE_OVERLAYS_DIR = join(findMonorepoRoot(), '.cat-cafe', 'prompt-overlays');

function templatePath(filename: string): string {
  return join(TEMPLATES_DIR, filename);
}

function overlayPath(filename: string): string {
  return join(TEMPLATE_OVERLAYS_DIR, filename);
}

/**
 * Resolve the effective file for a template, checking for .local overlay first.
 * Returns { path, isOverride } so callers can badge "customized" vs "default".
 */
function resolveWithOverlay(base: string, localSuffix: string): { path: string; isOverride: boolean } {
  const localPath = overlayPath(localSuffix);
  if (existsSync(localPath)) {
    return { path: localPath, isOverride: true };
  }
  return { path: templatePath(base), isOverride: false };
}

// ── Template rendering ───────────────────────────────────────

/**
 * Replace `{{KEY}}` placeholders in a template string.
 * Unresolved placeholders are left as-is (loud failure in prompt).
 */
export function renderTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (match, key: string) => {
    return key in vars ? vars[key] : match;
  });
}

/**
 * Strip HTML comment lines (<!-- ... -->) from markdown templates.
 * These are authoring-only annotations, not injected into prompts.
 */
export function stripComments(content: string): string {
  return content
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('<!--'))
    .join('\n')
    .trim();
}

// ── S6: Workflow Triggers (allowLocalOverride: true) ─────────

/**
 * Load per-breed workflow triggers from YAML.
 * Checks for workflow-triggers.local.yaml overlay first.
 * Returns Record<string, string> keyed by breedId.
 */
export function loadWorkflowTriggers(): Record<string, string> {
  const { path: filePath, isOverride } = resolveWithOverlay('workflow-triggers.yaml', 'workflow-triggers.local.yaml');
  if (!existsSync(filePath)) {
    console.warn('[prompt-template] workflow-triggers.yaml not found, using empty map');
    return {};
  }

  let parsed: unknown;
  try {
    parsed = YAML.parse(readFileSync(filePath, 'utf-8'));
  } catch (err) {
    console.warn(`[prompt-template] malformed YAML in ${filePath}: ${err}`);
    // Bad overlay → fall back to base; bad base → empty map
    if (isOverride) {
      const basePath = templatePath('workflow-triggers.yaml');
      if (existsSync(basePath)) {
        try {
          parsed = YAML.parse(readFileSync(basePath, 'utf-8'));
        } catch {
          console.warn('[prompt-template] base workflow-triggers.yaml also malformed, using empty map');
          return {};
        }
      } else {
        return {};
      }
    } else {
      return {};
    }
  }

  if (parsed == null || typeof parsed !== 'object') return {};

  // YAML block scalars have trailing newline — trim to match original .join('\n') output
  const result: Record<string, string> = {};
  for (const [breed, content] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof content === 'string') {
      result[breed] = content.trimEnd();
    }
  }
  return result;
}

// ── S13: MCP Tools Section (allowLocalOverride: true) ────────

/**
 * Load MCP tools section markdown template.
 * Checks for mcp-tools.local.md overlay first.
 * Caller provides RICH_BLOCK_SHORT for substitution.
 */
export function loadMcpToolsSection(vars: { RICH_BLOCK_SHORT: string }): string {
  const { path: filePath } = resolveWithOverlay('mcp-tools.md', 'mcp-tools.local.md');
  if (!existsSync(filePath)) {
    console.warn('[prompt-template] mcp-tools.md not found, returning empty');
    return '';
  }
  const raw = readFileSync(filePath, 'utf-8');
  return renderTemplate(stripComments(raw), vars);
}

// ── D8: A2A Ball Check (allowLocalOverride: false — no overlay) ──

/**
 * Load A2A ball ownership check prompt (no variables, no overlay).
 */
export function loadA2aBallCheck(): string {
  const filePath = templatePath('a2a-ball-check.md');
  if (!existsSync(filePath)) {
    console.warn('[prompt-template] a2a-ball-check.md not found, returning empty');
    return '';
  }
  return stripComments(readFileSync(filePath, 'utf-8'));
}

// ── D21: Handoff Decision Tree (allowLocalOverride: false — no overlay) ──

/**
 * Load handoff decision tree template (no overlay).
 * Caller provides CC_MENTION (co-creator mention pattern).
 */
export function loadHandoffDecisionTree(vars: { CC_MENTION: string }): string {
  const filePath = templatePath('handoff-decision-tree.md');
  if (!existsSync(filePath)) {
    console.warn('[prompt-template] handoff-decision-tree.md not found, returning empty');
    return '';
  }
  const raw = readFileSync(filePath, 'utf-8');
  return renderTemplate(stripComments(raw), vars);
}

// ── Override status query (for Console UI badges) ────────────

export interface OverrideStatus {
  segmentId: string;
  hasOverride: boolean;
  basePath: string;
  overridePath: string | null;
}

/** Known template-backed segments and their file mappings.
 *  Tier A (F237 template unification): simple {{VAR}} substitution.
 *  Existing: S6, S13, D8, D21. New Tier A: S1, S2, S8, D1, D5, D9-D11, D14, D16. */
const TEMPLATE_FILES: Record<string, { base: string; local: string }> = {
  // ── L0 section templates (compiled by compile-system-prompt-l0.mjs) ──
  L1: { base: 'l1-parallel-world.md', local: '' },
  L2: { base: 'l2-carry-over.md', local: '' },
  L3: { base: 'l3-routing-rules.md', local: '' },
  L4: { base: 'l4-iron-laws.md', local: '' },
  L5: { base: 'l5-mcp-tools-index.md', local: '' },
  L6: { base: 'l6-capability-wakeup.md', local: '' },
  L7: { base: 'l7-collaboration-philosophy.md', local: '' },
  // ── Non-Builder segments (M/C/N/B — migrated to template) ──
  M1: { base: 'm1-dispatch-mission.md', local: '' },
  M2: { base: 'm2-transcript-hints.md', local: '' },
  C1: { base: 'c1-mcp-callback.md', local: 'c1-mcp-callback.local.md' },
  N1: { base: 'n1-navigation.md', local: '' },
  // ── Existing templates ──
  S6: { base: 'workflow-triggers.yaml', local: 'workflow-triggers.local.yaml' },
  S13: { base: 'mcp-tools.md', local: 'mcp-tools.local.md' },
  D8: { base: 'a2a-ball-check.md', local: '' },
  D21: { base: 'handoff-decision-tree.md', local: '' },
  // ── Tier A: simple variable substitution (F237 template unification) ──
  S1: { base: 's1-identity.md', local: '' }, // F237: identity is config-driven, not user-editable
  S2: { base: 's2-restrictions.md', local: '' },
  S8: { base: 's8-cvo-reference.md', local: '' },
  D1: { base: 'd1-identity-anchor.md', local: '' },
  D5: { base: 'd5-ping-pong-warning.md', local: '' },
  D9: { base: 'd9-routing-feedback.md', local: '' },
  D10: { base: 'd10-critique-tag.md', local: '' },
  D11: { base: 'd11-skill-trigger.md', local: '' },
  D14: { base: 'd14-sop-stage.md', local: '' },
  D16: { base: 'd16-bootcamp.md', local: '' },
  // ── Tier B: computed placeholders (F237 template unification) ──
  S4: { base: 's4-collaboration.md', local: '' },
  D2: { base: 'd2-direct-message.md', local: '' },
  D3: { base: 'd3-same-breed-warning.md', local: '' },
  D4: { base: 'd4-cross-thread-reply.md', local: '' },
  D6: { base: 'd6-teammates.md', local: '' },
  D7: { base: 'd7-mode-serial.md', local: '' }, // F237: default variant for manifest D7 viewing
  D7_serial: { base: 'd7-mode-serial.md', local: '' },
  D7_parallel: { base: 'd7-mode-parallel.md', local: '' },
  D7_solo: { base: 'd7-mode-solo.md', local: '' },
  D12: { base: 'd12-active-participant.md', local: '' },
  D13: { base: 'd13-routing-policy.md', local: '' },
  D15: { base: 'd15-voice-off.md', local: '' },
  D15_on: { base: 'd15-voice-on.md', local: '' },
  D15_off: { base: 'd15-voice-off.md', local: '' },
  // ── Tier C: external delegates / pack passthroughs (F237 template unification) ──
  S3: { base: 's3-pack-masks.md', local: '' },
  S5: { base: 's5-teammate-roster.md', local: '' },
  S7: { base: 's7-pack-workflows.md', local: '' },
  S9: { base: 's9-governance-digest.md', local: '' },
  S10: { base: 's10-pack-guardrails.md', local: '' },
  S11: { base: 's11-pack-defaults.md', local: '' },
  S12: { base: 's12-world-driver.md', local: '' },
  D17: { base: 'd17-guide-candidate.md', local: '' },
  D18: { base: 'd18-world-context.md', local: '' },
  D19: { base: 'd19-constitutional-knowledge.md', local: '' },
  D20: { base: 'd20-signal-articles.md', local: '' },
};

/**
 * Check override status for a template-backed segment.
 * Returns null if the segment is not template-backed.
 */
export function getOverrideStatus(segmentId: string): OverrideStatus | null {
  const entry = TEMPLATE_FILES[segmentId];
  if (!entry) return null;
  const basePath = templatePath(entry.base);
  if (!entry.local) {
    return { segmentId, hasOverride: false, basePath, overridePath: null };
  }
  const localPath = overlayPath(entry.local);
  return {
    segmentId,
    hasOverride: existsSync(localPath),
    basePath,
    overridePath: entry.local ? localPath : null,
  };
}

/**
 * Get the raw content of a template file (base or override).
 * For Console display — returns unrendered template with {{VAR}} placeholders.
 */
export function getTemplateRawContent(segmentId: string, useOverride: boolean): string | null {
  const entry = TEMPLATE_FILES[segmentId];
  if (!entry) return null;

  if (useOverride && entry.local) {
    const localPath = overlayPath(entry.local);
    if (existsSync(localPath)) {
      return readFileSync(localPath, 'utf-8');
    }
  }

  const basePath = templatePath(entry.base);
  if (!existsSync(basePath)) return null;
  return readFileSync(basePath, 'utf-8');
}

/** Get the base filename for a template-backed segment */
export function getTemplateFileInfo(segmentId: string): { base: string; local: string } | null {
  return TEMPLATE_FILES[segmentId] ?? null;
}

/** Get the writable overlay path for a template-backed segment */
export function getTemplateOverlayPath(segmentId: string): string | null {
  const entry = TEMPLATE_FILES[segmentId];
  if (!entry?.local) return null;
  return overlayPath(entry.local);
}

// ── Generic segment rendering (F237 template unification) ───

/**
 * Load and render a template-backed segment with variable substitution.
 * Returns the rendered content, or null if the template file is missing.
 * Overlay resolution: .local file takes priority when present.
 */
export function renderSegment(segmentId: string, vars: Record<string, string> = {}): string | null {
  const entry = TEMPLATE_FILES[segmentId];
  if (!entry) return null;

  let filePath: string;
  if (entry.local) {
    const resolved = resolveWithOverlay(entry.base, entry.local);
    filePath = resolved.path;
  } else {
    filePath = templatePath(entry.base);
  }
  if (!existsSync(filePath)) return null;

  const raw = readFileSync(filePath, 'utf-8');
  return renderTemplate(stripComments(raw), vars);
}
