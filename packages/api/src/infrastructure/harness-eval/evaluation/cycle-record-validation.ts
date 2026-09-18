import type { CycleRecord } from '@cat-cafe/shared';

export function isCycleWindow(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const window = value as Partial<CycleRecord['windows'][number]>;
  if (
    !Number.isFinite(window.start) ||
    !Number.isFinite(window.end) ||
    (window.start ?? -1) < 0 ||
    (window.end ?? -1) < (window.start ?? 0)
  ) {
    return false;
  }
  if (window.provenance === undefined) return true;
  const provenance = window.provenance;
  return (
    provenance.kind === 'manual-version-switch' &&
    typeof provenance.sourceCycleId === 'string' &&
    typeof provenance.sourceVersion === 'string' &&
    typeof provenance.sourceVersionContentRef === 'string' &&
    typeof provenance.sourceSegmentId === 'string' &&
    Number.isSafeInteger(provenance.sourceSegmentVersion) &&
    provenance.sourceSegmentVersion > 0
  );
}

export function isCycleTermination(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const termination = value as Partial<NonNullable<CycleRecord['termination']>>;
  return (
    termination.kind === 'manual-version-switch' &&
    typeof termination.segmentId === 'string' &&
    Number.isSafeInteger(termination.fromVersion) &&
    (termination.fromVersion ?? 0) > 0 &&
    Number.isSafeInteger(termination.toVersion) &&
    (termination.toVersion ?? 0) > 0 &&
    (termination.baseVersion === undefined ||
      (Number.isSafeInteger(termination.baseVersion) && (termination.baseVersion ?? 0) > 0)) &&
    typeof termination.at === 'number' &&
    Number.isFinite(termination.at) &&
    termination.at >= 0 &&
    typeof termination.by === 'string' &&
    typeof termination.reason === 'string'
  );
}
