import { requireCaseRootValue } from './reeval-case-guards.js';
import type { ReevalCaseCycleRoot, ReevalCaseRoot } from './reeval-case-types.js';
import { ReevalClosureProjectionError } from './reeval-closure.js';
import { type EvalLifecycleEvent, EvalLifecycleEventSchema } from './reeval-closure-schema.js';

export function parseReevalCaseHistory(
  root: ReevalCaseRoot,
  rawEvents: readonly unknown[],
): { cycles: Map<string, ReevalCaseCycleRoot>; history: EvalLifecycleEvent[] } {
  requireCaseRootValue(root.caseId, 'caseId');
  requireCaseRootValue(root.domainId, 'domainId');
  requireCaseRootValue(root.targetOwnerCatId, 'targetOwnerCatId');
  if (root.assignedEvalCatId !== undefined) requireCaseRootValue(root.assignedEvalCatId, 'assignedEvalCatId');
  if (root.cycles.length === 0) {
    throw new ReevalClosureProjectionError('invalid_root', 'case root cycles must be non-empty');
  }
  const cycles = new Map(root.cycles.map((cycle) => [cycle.verdictId, cycle]));
  if (cycles.size !== root.cycles.length) {
    throw new ReevalClosureProjectionError('invalid_root', 'case root verdict cycles must be unique');
  }
  const history = rawEvents.map((rawEvent, index) => {
    const parsed = EvalLifecycleEventSchema.safeParse(rawEvent);
    if (!parsed.success) {
      throw new ReevalClosureProjectionError(
        'invalid_event',
        `invalid case lifecycle event ${index}: ${parsed.error.message}`,
      );
    }
    const event = parsed.data;
    if (event.caseId !== root.caseId || event.domainId !== root.domainId) {
      throw new ReevalClosureProjectionError(
        'identity_mismatch',
        `event ${index} does not belong to case ${root.caseId}`,
      );
    }
    if (!cycles.has(event.verdictId)) {
      throw new ReevalClosureProjectionError(
        'identity_mismatch',
        `event ${index} uses unregistered cycle ${event.verdictId}`,
      );
    }
    return event;
  });
  if (history[0]?.type !== 'verdict_cycle_observed' && history[0]?.type !== 'legacy_case_migrated') {
    throw new ReevalClosureProjectionError(
      'invalid_history',
      'first case event must establish a verdict cycle or legacy migration',
    );
  }
  return { cycles, history };
}
