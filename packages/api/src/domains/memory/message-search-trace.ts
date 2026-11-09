import { auditIdPattern, safeCandidateAudit } from './message-candidate-audit-wire.js';

/** Current source-search phases only. Retired provider events cannot re-enter the log surface. */
const phases = new Set([
  'visibility',
  'source-admission',
  'retrieval',
  'canonical-projection',
  'decision-sources',
  'final-revalidation',
]);

export function privateMessageSearchTrace(trace: Record<string, unknown>): Record<string, unknown> | undefined {
  try {
    if (trace.phase === 'candidate-audit') {
      if (typeof trace.searchId !== 'string' || !auditIdPattern.test(trace.searchId)) return;
      const candidateAudit = safeCandidateAudit(trace.candidateAudit);
      if (!candidateAudit || candidateAudit.id !== trace.searchId) {
        if (trace.state === 'identity_unavailable' || trace.state === 'capture_incomplete')
          return { phase: 'candidate-audit', searchId: trace.searchId, state: trace.state };
        return;
      }
      if (typeof trace.readerExecutionId !== 'string' || !auditIdPattern.test(trace.readerExecutionId)) return;
      return {
        phase: 'candidate-audit',
        searchId: trace.searchId,
        readerExecutionId: trace.readerExecutionId,
        candidateAudit,
      };
    }
    if (typeof trace.phase !== 'string' || !phases.has(trace.phase)) return;
    const result: Record<string, unknown> = { phase: trace.phase };
    for (const key of ['elapsedMs', 'phaseElapsedMs']) {
      const value = trace[key];
      if (typeof value === 'number' && Number.isFinite(value) && value >= 0) result[key] = value;
    }
    return result;
  } catch {
    return;
  } // Hostile getter/observer must not own result/error semantics.
}
