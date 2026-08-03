import type { CapabilityWakeupSourceSelector } from '../capability-wakeup/capability-wakeup-trial-provider.js';
import { validateCapabilityWakeupSelector } from '../capability-wakeup/capability-wakeup-trial-provider.js';
import type { HandlerError, VerdictSourceRefs } from './types.js';
import {
  isA2aSourceRefs,
  isAnchorTelemetrySourceRefs,
  isFreshnessReplaySourceRefs,
  isFrictionSourceRefs,
  isMemorySourceRefs,
  isQcMetricsSourceRefs,
  isSopSourceRefs,
  isTaskOutcomeSourceRefs,
  validateAnchorTelemetrySelector,
  validateFreshnessReplaySelector,
  validateFrictionRollupSelector,
  validateMemoryRecallSelector,
  validateQcMetricsSelector,
  validateSopTraceSelector,
  validateSourceRefsFormat,
  validateTaskOutcomeSourceRefs,
} from './validation.js';

export function validateSourceRefsForPublish(sourceRefs: VerdictSourceRefs): HandlerError | null {
  if (isSopSourceRefs(sourceRefs)) return selectorError(validateSopTraceSelector(sourceRefs));
  if (isMemorySourceRefs(sourceRefs)) return selectorError(validateMemoryRecallSelector(sourceRefs));
  // Kind-discriminated guards must precede the backward-compatible a2a default.
  if (isFrictionSourceRefs(sourceRefs)) return selectorError(validateFrictionRollupSelector(sourceRefs));
  if (isAnchorTelemetrySourceRefs(sourceRefs)) return selectorError(validateAnchorTelemetrySelector(sourceRefs));
  if (isQcMetricsSourceRefs(sourceRefs)) return selectorError(validateQcMetricsSelector(sourceRefs));
  if (isFreshnessReplaySourceRefs(sourceRefs)) return selectorError(validateFreshnessReplaySelector(sourceRefs));
  if (isA2aSourceRefs(sourceRefs)) {
    const result = validateSourceRefsFormat(sourceRefs);
    return result.ok ? null : result.error;
  }
  if (isTaskOutcomeSourceRefs(sourceRefs)) {
    const result = validateTaskOutcomeSourceRefs(sourceRefs);
    return result.ok ? null : result.error;
  }
  const selector = sourceRefs as unknown as CapabilityWakeupSourceSelector;
  const error = validateCapabilityWakeupSelector(selector);
  if (error) return selectorError(error);
  if (selector.kind !== 'capability-wakeup-trial-window') {
    return {
      status: 400,
      error: 'invalid_source_ref',
      detail: `Only 'capability-wakeup-trial-window' is wired; got '${selector.kind}'.`,
    };
  }
  return null;
}

function selectorError(detail: string | null): HandlerError | null {
  return detail ? { status: 400, error: 'invalid_source_ref', detail } : null;
}
