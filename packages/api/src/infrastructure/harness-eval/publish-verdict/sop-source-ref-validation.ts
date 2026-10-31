import { validateSopTraceInput } from '../sop/sop-trace-adapter.js';
import type { SopTraceSourceSelector, VerdictSourceRefs } from './types.js';

/**
 * F192 sop-wiring — discriminator helper for SOP trace selector.
 */
export function isSopSourceRefs(refs: VerdictSourceRefs | undefined): refs is SopTraceSourceSelector {
  if (!refs) return false;
  if (!('kind' in refs)) return false;
  return refs.kind === 'sop-trace-eval';
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
  return validateSopTraceInput(selector.trace);
}
