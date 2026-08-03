import type { FrictionRollupSourceSelector } from '@cat-cafe/shared';
import type { FreshnessReplaySelector } from '../freshness/freshness-replay-types.js';
import type { QcMetricsSelector } from '../qc-metrics-provider.js';
import type { VerdictHandoffPacket } from '../verdict-handoff.js';
import { isA2aSourceRefs } from './a2a-source-ref-validation.js';
import { isSopSourceRefs } from './sop-source-ref-validation.js';
import { isTaskOutcomeSourceRefs } from './task-outcome-source-ref-validation.js';
import type {
  AnchorTelemetrySourceSelector,
  HandlerError,
  MemoryRecallSourceSelector,
  VerdictSourceRefs,
} from './types.js';

export { isA2aSourceRefs, resolveSourceRefsInRoot, validateSourceRefsFormat } from './a2a-source-ref-validation.js';
export { isSopSourceRefs, validateSopTraceSelector } from './sop-source-ref-validation.js';
export { isTaskOutcomeSourceRefs, validateTaskOutcomeSourceRefs } from './task-outcome-source-ref-validation.js';

/**
 * F192 publish_verdict eval:memory wire-up — discriminator helper for memory selector.
 */
export function isMemorySourceRefs(refs: VerdictSourceRefs | undefined): refs is MemoryRecallSourceSelector {
  if (!refs) return false;
  if (!('kind' in refs)) return false;
  return refs.kind === 'memory-recall-snapshot';
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

/**
 * F253 Phase C — discriminator helper for QC metrics selector.
 */
export function isQcMetricsSourceRefs(refs: VerdictSourceRefs | undefined): refs is QcMetricsSelector {
  if (!refs) return false;
  if (!('kind' in refs)) return false;
  return refs.kind === 'qc-metrics-rollup';
}

export function isFreshnessReplaySourceRefs(refs: VerdictSourceRefs | undefined): refs is FreshnessReplaySelector {
  if (!refs) return false;
  if (!('kind' in refs)) return false;
  return refs.kind === 'freshness-closure-replay';
}

/**
 * F253 Phase C — structural validator for QC metrics selector.
 * Returns user-facing error detail; handler maps to 400 invalid_source_ref.
 */
export function validateQcMetricsSelector(selector: QcMetricsSelector): string | null {
  if (selector.kind !== 'qc-metrics-rollup') {
    return `expected kind='qc-metrics-rollup', got '${(selector as { kind?: string }).kind ?? '(omitted)'}'`;
  }
  if (typeof selector.windowStartMs !== 'number' || !Number.isFinite(selector.windowStartMs)) {
    return 'windowStartMs must be a finite number';
  }
  if (typeof selector.windowEndMs !== 'number' || !Number.isFinite(selector.windowEndMs)) {
    return 'windowEndMs must be a finite number';
  }
  if (selector.windowEndMs <= selector.windowStartMs) {
    return `windowEndMs (${selector.windowEndMs}) must be > windowStartMs (${selector.windowStartMs})`;
  }
  return null;
}

export const KNOWN_SOURCE_REFS_KINDS = [
  'a2a-snapshot-attribution',
  'anchor-telemetry-snapshot',
  'capability-wakeup-trial-window',
  'memory-recall-snapshot',
  'qc-metrics-rollup',
  'sop-trace-eval',
  'task-outcome-snapshot',
  'friction-rollup-snapshot',
  'freshness-closure-replay',
] as const;

export function isKnownSourceRefsKind(kind: string): kind is (typeof KNOWN_SOURCE_REFS_KINDS)[number] {
  return KNOWN_SOURCE_REFS_KINDS.includes(kind as (typeof KNOWN_SOURCE_REFS_KINDS)[number]);
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
  if (isQcMetricsSourceRefs(refs)) return 'qc-metrics-rollup';
  if (isFreshnessReplaySourceRefs(refs)) return 'freshness-closure-replay';
  if (isA2aSourceRefs(refs)) return 'a2a-snapshot-attribution';
  if (refs && typeof refs === 'object' && 'kind' in refs && typeof refs.kind === 'string') {
    return refs.kind;
  }
  return 'a2a-snapshot-attribution';
}

const MAX_FRESHNESS_REPLAY_WINDOW_MS = 31 * 24 * 60 * 60 * 1_000;
const MAX_FRESHNESS_SELECTOR_IDS = 50;

/** F254 AC-E9 — bounded, server-resolved freshness replay selector. */
export function validateFreshnessReplaySelector(selector: FreshnessReplaySelector): string | null {
  if (selector.kind !== 'freshness-closure-replay') {
    return `expected kind='freshness-closure-replay', got '${(selector as { kind?: string }).kind ?? '(omitted)'}'`;
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
  if (selector.windowEndMs - selector.windowStartMs > MAX_FRESHNESS_REPLAY_WINDOW_MS) {
    return 'freshness replay window must not exceed 31 days';
  }
  const threadError = validateSelectorIds(selector.threadIds, 'threadIds');
  if (threadError) return threadError;
  if ('fixtureIds' in selector) return 'fixtureIds is server-owned and cannot be caller-selected';
  return null;
}

function validateSelectorIds(values: string[] | undefined, fieldName: string): string | null {
  if (values === undefined) return null;
  if (!Array.isArray(values) || values.length === 0 || values.length > MAX_FRESHNESS_SELECTOR_IDS) {
    return `${fieldName} must contain 1-${MAX_FRESHNESS_SELECTOR_IDS} ids when provided`;
  }
  if (values.some((value) => typeof value !== 'string' || value.length === 0 || /[\r\n]/.test(value))) {
    return `${fieldName} entries must be non-empty strings without newlines`;
  }
  if (new Set(values).size !== values.length) return `${fieldName} entries must be unique`;
  return null;
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
