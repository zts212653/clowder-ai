import { basename, isAbsolute, resolve } from 'node:path';
import type { FrictionRollupSourceSelector } from '@cat-cafe/shared';
import { resolveSafeRawPath } from '../safe-path.js';
import { VERDICT_CLASSES } from '../task-outcome/task-outcome-episode.js';
import type { VerdictHandoffPacket } from '../verdict-handoff.js';
import type {
  A2aSnapshotAttributionRefs,
  AnchorTelemetrySourceSelector,
  HandlerError,
  MemoryRecallSourceSelector,
  ResolvedSourceRefs,
  SopTraceSourceSelector,
  TaskOutcomeSnapshotSourceRefs,
  VerdictSourceRefs,
} from './types.js';

/**
 * F192 Phase H 收尾 PR-2: discriminator helper for the VerdictSourceRefs union.
 * Returns true when sourceRefs is the a2a variant (or unspecified, default a2a for backward compat).
 */
export function isA2aSourceRefs(refs: VerdictSourceRefs | undefined): refs is A2aSnapshotAttributionRefs {
  if (!refs) return true; // empty/undefined defaults to a2a interpretation
  if (!('kind' in refs) || refs.kind === undefined) return true;
  return refs.kind === 'a2a-snapshot-attribution';
}

export function isTaskOutcomeSourceRefs(refs: VerdictSourceRefs | undefined): refs is TaskOutcomeSnapshotSourceRefs {
  return Boolean(refs && 'kind' in refs && refs.kind === 'task-outcome-snapshot');
}

/**
 * F192 publish_verdict eval:memory wire-up — discriminator helper for memory selector.
 */
export function isMemorySourceRefs(refs: VerdictSourceRefs | undefined): refs is MemoryRecallSourceSelector {
  if (!refs) return false;
  if (!('kind' in refs)) return false;
  return refs.kind === 'memory-recall-snapshot';
}

/**
 * F192 sop-wiring — discriminator helper for SOP trace selector.
 */
export function isSopSourceRefs(refs: VerdictSourceRefs | undefined): refs is SopTraceSourceSelector {
  if (!refs) return false;
  if (!('kind' in refs)) return false;
  return refs.kind === 'sop-trace-eval';
}

/**
 * F245 Phase C PR1b — discriminator helper for friction rollup selector.
 */
export function isFrictionSourceRefs(refs: VerdictSourceRefs | undefined): refs is FrictionRollupSourceSelector {
  if (!refs) return false;
  if (!('kind' in refs)) return false;
  return refs.kind === 'friction-rollup-snapshot';
}

/**
 * F236 Track-2 AC-E4 — discriminator helper for anchor telemetry selector.
 */
export function isAnchorTelemetrySourceRefs(
  refs: VerdictSourceRefs | undefined,
): refs is AnchorTelemetrySourceSelector {
  if (!refs) return false;
  if (!('kind' in refs)) return false;
  return refs.kind === 'anchor-telemetry-snapshot';
}

export const KNOWN_SOURCE_REFS_KINDS = [
  'a2a-snapshot-attribution',
  'anchor-telemetry-snapshot',
  'capability-wakeup-trial-window',
  'memory-recall-snapshot',
  'sop-trace-eval',
  'task-outcome-snapshot',
  'friction-rollup-snapshot',
] as const;

export function isKnownSourceRefsKind(kind: string): kind is (typeof KNOWN_SOURCE_REFS_KINDS)[number] {
  return KNOWN_SOURCE_REFS_KINDS.includes(kind as (typeof KNOWN_SOURCE_REFS_KINDS)[number]);
}

/**
 * F192 sop-wiring — structural validator for SOP trace selector.
 * Returns user-facing error detail; handler maps to 400 invalid_source_ref.
 */
export function validateSopTraceSelector(selector: SopTraceSourceSelector): string | null {
  if (selector.kind !== 'sop-trace-eval') {
    return `expected kind='sop-trace-eval', got '${(selector as { kind?: string }).kind ?? '(omitted)'}'`;
  }
  if (typeof selector.sopDefinitionId !== 'string' || selector.sopDefinitionId.length === 0) {
    return 'sopDefinitionId must be a non-empty string';
  }
  if (/[\r\n]/.test(selector.sopDefinitionId)) {
    return 'sopDefinitionId must not contain newlines';
  }
  if (!selector.trace || typeof selector.trace !== 'object') {
    return 'trace must be a non-null object (SopTraceInput)';
  }
  if (typeof selector.trace.sessionId !== 'string' || selector.trace.sessionId.length === 0) {
    return 'trace.sessionId must be a non-empty string';
  }
  if (typeof selector.trace.observedStage !== 'string' || selector.trace.observedStage.length === 0) {
    return 'trace.observedStage must be a non-empty string';
  }
  return null;
}

/**
 * Infer the concrete sourceRefs.kind string used by publish-verdict.
 * Known kinds stay as explicit literals; unknown string kinds pass through
 * unchanged so the handler can fail closed with an honest unsupported-kind
 * error instead of misclassifying them as an existing domain's selector.
 */
export function inferSourceRefsKind(refs: VerdictSourceRefs | undefined): string {
  if (isSopSourceRefs(refs)) return 'sop-trace-eval';
  if (isMemorySourceRefs(refs)) return 'memory-recall-snapshot';
  if (isTaskOutcomeSourceRefs(refs)) return 'task-outcome-snapshot';
  // ⚠️ anchor-telemetry + friction guards MUST precede the a2a default:
  // isA2aSourceRefs returns true for undefined/missing-kind refs (backward-compat
  // default) and would swallow kind-discriminated selectors otherwise.
  if (isAnchorTelemetrySourceRefs(refs)) return 'anchor-telemetry-snapshot';
  if (isFrictionSourceRefs(refs)) return 'friction-rollup-snapshot';
  if (isA2aSourceRefs(refs)) return 'a2a-snapshot-attribution';
  if (refs && typeof refs === 'object' && 'kind' in refs && typeof refs.kind === 'string') {
    return refs.kind;
  }
  return 'a2a-snapshot-attribution';
}

/**
 * F192 publish_verdict eval:memory wire-up — structural validator for memory selector.
 * Mirrors `validateCapabilityWakeupSelector` shape (non-throw, returns error string or null).
 * Returns user-facing error detail; handler maps to 400 invalid_source_ref.
 */
export function validateMemoryRecallSelector(selector: MemoryRecallSourceSelector): string | null {
  if (selector.kind !== 'memory-recall-snapshot') {
    return `expected kind='memory-recall-snapshot', got '${(selector as { kind?: string }).kind ?? '(omitted)'}'`;
  }
  if (typeof selector.windowDays !== 'number' || !Number.isInteger(selector.windowDays)) {
    return 'windowDays must be an integer';
  }
  if (selector.windowDays < 1 || selector.windowDays > 90) {
    return 'windowDays must be in range [1, 90] (recall API ceiling)';
  }
  const catIdError = validateOptionalIdField(selector.catId, 'catId');
  if (catIdError) return catIdError;
  const toolNameError = validateOptionalIdField(selector.toolName, 'toolName');
  if (toolNameError) return toolNameError;
  return null;
}

function validateOptionalIdField(value: string | undefined, fieldName: string): string | null {
  if (value === undefined) return null;
  if (typeof value !== 'string' || value.length === 0) {
    return `${fieldName} must be a non-empty string`;
  }
  if (/[\r\n]/.test(value)) {
    return `${fieldName} must not contain newlines (markdown bullet injection guard)`;
  }
  return null;
}

/**
 * F245 Phase C PR1b — structural validator for the friction rollup selector.
 * Mirrors `validateMemoryRecallSelector` / `validateTaskOutcomeSourceRefs` shape
 * (non-throw, returns user-facing error detail or null). Handler maps to 400
 * invalid_source_ref. Generator-adapter also calls it (defense-in-depth).
 */
export function validateFrictionRollupSelector(selector: FrictionRollupSourceSelector): string | null {
  if (selector.kind !== 'friction-rollup-snapshot') {
    return `expected kind='friction-rollup-snapshot', got '${(selector as { kind?: string }).kind ?? '(omitted)'}'`;
  }
  if (typeof selector.windowStartMs !== 'number' || !Number.isFinite(selector.windowStartMs)) {
    return 'windowStartMs must be a finite number';
  }
  if (typeof selector.windowEndMs !== 'number' || !Number.isFinite(selector.windowEndMs)) {
    return 'windowEndMs must be a finite number';
  }
  if (selector.windowEndMs <= selector.windowStartMs) {
    return 'windowEndMs must be greater than windowStartMs';
  }
  const topNError = validateOptionalPositiveInt(selector.topN, 'topN');
  if (topNError) return topNError;
  const tokenCapError = validateOptionalPositiveInt(selector.tokenCap, 'tokenCap');
  if (tokenCapError) return tokenCapError;
  return null;
}

function validateOptionalPositiveInt(value: number | undefined, fieldName: string): string | null {
  if (value === undefined) return null;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    return `${fieldName} must be a positive integer when provided`;
  }
  return null;
}

/**
 * F236 Track-2 AC-E4 — structural validator for anchor telemetry selector.
 * Mirrors validateFrictionRollupSelector shape (window-only, no optional fields).
 */
export function validateAnchorTelemetrySelector(selector: AnchorTelemetrySourceSelector): string | null {
  if (selector.kind !== 'anchor-telemetry-snapshot') {
    return `expected kind='anchor-telemetry-snapshot', got '${(selector as { kind?: string }).kind ?? '(omitted)'}'`;
  }
  if (typeof selector.windowStartMs !== 'number' || !Number.isFinite(selector.windowStartMs)) {
    return 'windowStartMs must be a finite number';
  }
  if (typeof selector.windowEndMs !== 'number' || !Number.isFinite(selector.windowEndMs)) {
    return 'windowEndMs must be a finite number';
  }
  if (selector.windowEndMs <= selector.windowStartMs) {
    return 'windowEndMs must be greater than windowStartMs';
  }
  return null;
}

function hasParentTraversalSegment(value: string): boolean {
  return value.split(/[\\/]+/).some((segment) => segment === '..');
}

/**
 * F192 Phase H publish-verdict validation helpers.
 * Extracted from publish-verdict.ts per AGENTS.md 350-line hard limit.
 */

/**
 * Validate sourceRefs format (presence + type + basename — no path resolution).
 * Path resolution happens inside stage callback against LIVE harnessFeedbackRoot
 * (砚砚 R17 P1 cloud: snapshots/attributions are gitignored, only in live).
 */
export function validateSourceRefsFormat(
  sourceRefs: VerdictSourceRefs | undefined,
): { ok: true } | { ok: false; error: HandlerError } {
  if (!isA2aSourceRefs(sourceRefs)) {
    return {
      ok: false,
      error: {
        status: 400,
        error: 'invalid_source_ref',
        detail: `validateSourceRefsFormat called with non-a2a sourceRefs (kind=${(sourceRefs as { kind?: string }).kind ?? 'unknown'}); use isA2aSourceRefs guard before calling.`,
      },
    };
  }
  const snap = sourceRefs?.snapshotName;
  const attr = sourceRefs?.attributionName;
  if (!snap || !attr) {
    return {
      ok: false,
      error: {
        status: 400,
        error: 'missing_evidence_refs',
        detail:
          'eval:a2a requires sourceRefs.snapshotName + .attributionName (basenames). Tool will not fabricate evidence.',
      },
    };
  }
  if (typeof snap !== 'string' || typeof attr !== 'string') {
    return {
      ok: false,
      error: {
        status: 400,
        error: 'invalid_source_ref',
        detail: `sourceRefs.snapshotName + .attributionName must be strings (got ${typeof snap}, ${typeof attr})`,
      },
    };
  }
  for (const [field, value] of [
    ['snapshotName', snap],
    ['attributionName', attr],
  ] as const) {
    if (value === '.' || value === '..' || basename(value) !== value) {
      return {
        ok: false,
        error: {
          status: 400,
          error: 'invalid_source_ref',
          detail: `${field} invalid: must be simple basename (no path separators, no '.' / '..')`,
        },
      };
    }
  }
  return { ok: true };
}

export function resolveSourceRefsInRoot(
  harnessFeedbackRoot: string,
  snap: string,
  attr: string,
): { ok: true; refs: ResolvedSourceRefs } | { ok: false; reason: string } {
  const snapResult = resolveSafeRawPath(resolve(harnessFeedbackRoot, 'snapshots'), snap);
  if (!snapResult.ok) return { ok: false, reason: `snapshotName invalid: ${snapResult.reason}` };
  const attrResult = resolveSafeRawPath(resolve(harnessFeedbackRoot, 'attributions'), attr);
  if (!attrResult.ok) return { ok: false, reason: `attributionName invalid: ${attrResult.reason}` };
  return { ok: true, refs: { snapshotPath: snapResult.path, attributionPath: attrResult.path } };
}

export function validateTaskOutcomeSourceRefs(
  sourceRefs: VerdictSourceRefs | undefined,
): { ok: true } | { ok: false; error: HandlerError } {
  if (!isTaskOutcomeSourceRefs(sourceRefs)) {
    return {
      ok: false,
      error: {
        status: 400,
        error: 'invalid_source_ref',
        detail: `validateTaskOutcomeSourceRefs called with non-task-outcome sourceRefs (kind=${(sourceRefs as { kind?: string } | undefined)?.kind ?? 'unknown'}); use isTaskOutcomeSourceRefs guard before calling.`,
      },
    };
  }
  if (
    typeof sourceRefs.windowStartMs !== 'number' ||
    !Number.isFinite(sourceRefs.windowStartMs) ||
    typeof sourceRefs.windowEndMs !== 'number' ||
    !Number.isFinite(sourceRefs.windowEndMs)
  ) {
    return {
      ok: false,
      error: {
        status: 400,
        error: 'invalid_source_ref',
        detail: 'task-outcome-snapshot requires finite numeric windowStartMs and windowEndMs',
      },
    };
  }
  if (sourceRefs.windowEndMs <= sourceRefs.windowStartMs) {
    return {
      ok: false,
      error: {
        status: 400,
        error: 'invalid_source_ref',
        detail: 'task-outcome-snapshot requires windowEndMs > windowStartMs',
      },
    };
  }
  for (const [field, value] of [
    ['databasePath', sourceRefs.databasePath],
    ['evidenceCatId', sourceRefs.evidenceCatId],
  ] as const) {
    if (value !== undefined && typeof value !== 'string') {
      return {
        ok: false,
        error: {
          status: 400,
          error: 'invalid_source_ref',
          detail: `${field} must be a string when provided`,
        },
      };
    }
    if (typeof value === 'string' && /[\r\n]/.test(value)) {
      return {
        ok: false,
        error: {
          status: 400,
          error: 'invalid_source_ref',
          detail: `${field} must not contain newlines`,
        },
      };
    }
    if (field === 'databasePath' && typeof value === 'string') {
      if (isAbsolute(value)) {
        return {
          ok: false,
          error: {
            status: 400,
            error: 'invalid_source_ref',
            detail: 'databasePath must be repo-relative (absolute paths are forbidden)',
          },
        };
      }
      if (hasParentTraversalSegment(value)) {
        return {
          ok: false,
          error: {
            status: 400,
            error: 'invalid_source_ref',
            detail: 'databasePath must not contain parent-directory traversal segments ("..")',
          },
        };
      }
    }
  }
  const episodeVerdictsError = validateEpisodeVerdicts(sourceRefs.episodeVerdicts);
  if (episodeVerdictsError) return episodeVerdictsError;
  return { ok: true };
}

function validateEpisodeVerdicts(
  episodeVerdicts: TaskOutcomeSnapshotSourceRefs['episodeVerdicts'],
): { ok: false; error: HandlerError } | null {
  if (episodeVerdicts === undefined) return null;
  if (!Array.isArray(episodeVerdicts) || episodeVerdicts.length === 0) {
    return {
      ok: false,
      error: {
        status: 400,
        error: 'invalid_source_ref',
        detail: 'episodeVerdicts must be a non-empty array when provided',
      },
    };
  }
  const seen = new Set<string>();
  for (const [index, entry] of episodeVerdicts.entries()) {
    if (!entry || typeof entry !== 'object') {
      return invalidEpisodeVerdict(index, 'must be an object');
    }
    const episodeId = (entry as { episodeId?: unknown }).episodeId;
    if (typeof episodeId !== 'string' || episodeId.length === 0 || /[\r\n]/.test(episodeId)) {
      return invalidEpisodeVerdict(index, 'episodeId must be a non-empty string without newlines');
    }
    if (seen.has(episodeId)) {
      return invalidEpisodeVerdict(index, `duplicate episodeId '${episodeId}'`);
    }
    seen.add(episodeId);
    const verdict = (entry as { verdict?: unknown }).verdict;
    if (typeof verdict !== 'string' || !VERDICT_CLASSES.includes(verdict as (typeof VERDICT_CLASSES)[number])) {
      return invalidEpisodeVerdict(index, `verdict must be one of ${VERDICT_CLASSES.join(', ')}`);
    }
  }
  return null;
}

function invalidEpisodeVerdict(index: number, detail: string): { ok: false; error: HandlerError } {
  return {
    ok: false,
    error: {
      status: 400,
      error: 'invalid_source_ref',
      detail: `episodeVerdicts[${index}] ${detail}`,
    },
  };
}

/**
 * 砚砚 R18/R19 P2 + cloud R18 P2: reject newline in EVERY packet string field that
 * renderer (eval-a2a-verdict-renderer.ts) interpolates into single-line markdown bullets.
 * Read-model regex parses first line → newline truncates AND enables bullet-injection
 * (e.g. phenomenon='x\n- Owner ask: pwned' rewrites Hub's owner ask). 砚砚 R19 found
 * componentId/featureId/metricRefs/sampleTraceRefs were missed; this lists is now
 * exhaustive against the renderer source.
 */
export function assertNoNewlineInBulletFields(packet: VerdictHandoffPacket): HandlerError | null {
  const fields: Array<[string, string]> = [
    ['phenomenon', packet.phenomenon],
    ['harnessUnderEval.featureId', packet.harnessUnderEval.featureId],
    ['harnessUnderEval.componentId', packet.harnessUnderEval.componentId],
    ['harnessUnderEval.name', packet.harnessUnderEval.name],
    ['ownerAsk.requestedAction', packet.ownerAsk.requestedAction],
    // cloud-R2 P2: rootCauseHypothesis.summary renders as a single-line `- Root cause:` bullet
    // (eval-friction-renderer) directly above `- Owner ask:`; a newline injects a fake bullet that
    // corrupts Eval Hub extractBullet read-model. Guard it like the other single-line bullet fields.
    ['rootCauseHypothesis.summary', packet.rootCauseHypothesis.summary],
    ['acceptanceReevalPlan.closureCondition', packet.acceptanceReevalPlan.closureCondition],
    ['acceptanceReevalPlan.nextEvalAt', packet.acceptanceReevalPlan.nextEvalAt],
    ...packet.evidencePacket.metricRefs.map((r, i): [string, string] => [`evidencePacket.metricRefs[${i}]`, r]),
    ...packet.evidencePacket.sampleTraceRefs.map((r, i): [string, string] => [
      `evidencePacket.sampleTraceRefs[${i}]`,
      r,
    ]),
    ...packet.counterarguments.map((c, i): [string, string] => [`counterarguments[${i}]`, c]),
  ];
  for (const [name, value] of fields) {
    if (/[\r\n]/.test(value)) {
      return {
        status: 400,
        error: 'invalid_packet_field',
        detail: `${name} must not contain newline characters (renderer writes single-line bullets; newlines truncate/inject)`,
      };
    }
  }
  return null;
}
