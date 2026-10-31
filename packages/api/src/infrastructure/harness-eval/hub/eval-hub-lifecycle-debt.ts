import type { LifecycleRootArtifact } from '../publish-verdict/lifecycle-root-artifact.js';
import type { ReevalCaseProjection } from '../reeval-case.js';
import type { ReevalClosureProjection } from '../reeval-closure.js';
import type { EvalHubLifecycleView } from './eval-hub-read-model-types.js';

type LifecyclePresentation = Pick<
  EvalHubLifecycleView,
  | 'ownerResponseStatus'
  | 'reevalStatus'
  | 'reevalDueAt'
  | 'escalation'
  | 'stale'
  | 'repairDebtStatus'
  | 'reevalDebtStatus'
>;

function latestReevalResult(
  projection: ReevalClosureProjection | ReevalCaseProjection,
): NonNullable<EvalHubLifecycleView['reevalStatus']> {
  const activeVerdictId = 'activeVerdictId' in projection ? projection.activeVerdictId : undefined;
  for (let index = projection.history.length - 1; index >= 0; index -= 1) {
    const event = projection.history[index];
    if (activeVerdictId && event?.verdictId !== activeVerdictId) continue;
    if (event?.type === 'reeval_passed') return 'passed';
    if (event?.type === 'reeval_failed') return 'failed';
  }
  return 'not_requested';
}

function hasActiveReevaluation(projection: ReevalClosureProjection | ReevalCaseProjection): boolean {
  return (
    projection.status === 'reeval_pending' ||
    (projection.status === 'escalated' && projection.escalation?.stage === 'reevaluation')
  );
}

function projectRepairDebtStatus(
  projection: ReevalClosureProjection | ReevalCaseProjection,
): EvalHubLifecycleView['repairDebtStatus'] {
  if (projection.status === 'escalated') {
    return projection.escalation?.stage === 'acknowledgement' ? 'active' : 'cleared';
  }
  if (projection.status === 'monitoring' || projection.status === 'suppressed_with_reason') return 'not_required';
  if (['open', 'acknowledged', 'action_planned', 'fix_landed', 'main_landed'].includes(projection.status)) {
    return 'active';
  }
  return 'cleared';
}

function projectReevalDebtStatus(
  projection: ReevalClosureProjection | ReevalCaseProjection,
  latestResult: ReturnType<typeof latestReevalResult>,
  activeReeval: boolean,
  cadenceDue: boolean,
): EvalHubLifecycleView['reevalDebtStatus'] {
  if (activeReeval) return 'in_progress';
  if (projection.status === 'live_active' || projection.status === 'monitoring') {
    return cadenceDue ? 'due' : 'scheduled';
  }
  if (latestResult === 'passed' || latestResult === 'failed') return latestResult;
  return 'not_scheduled';
}

function isLifecycleStale(
  projection: ReevalClosureProjection | ReevalCaseProjection,
  cadenceDue: boolean,
  generatedAt: string,
): boolean {
  if (projection.status === 'escalated') return true;
  if (projection.status === 'monitoring') return cadenceDue;
  return (
    projection.status === 'reeval_pending' &&
    projection.reevalDueAt !== undefined &&
    Date.parse(generatedAt) >= Date.parse(projection.reevalDueAt)
  );
}

export function projectLifecyclePresentation(
  projection: ReevalClosureProjection | ReevalCaseProjection,
  generatedAt: string,
  activeRoot?: LifecycleRootArtifact,
): LifecyclePresentation {
  const suppressed = projection.status === 'suppressed_with_reason';
  const activeReeval = hasActiveReevaluation(projection);
  const latestResult = latestReevalResult(projection);
  const reevalStatus = suppressed ? 'not_required' : activeReeval ? 'pending' : latestResult;
  const nextEvalAt = activeRoot?.acceptanceReevalPlan.nextEvalAt;
  const cadenceDue = nextEvalAt !== undefined && Date.parse(generatedAt) >= Date.parse(nextEvalAt);
  const stale = isLifecycleStale(projection, cadenceDue, generatedAt);
  const repairDebtStatus = projectRepairDebtStatus(projection);
  const reevalDebtStatus = projectReevalDebtStatus(projection, latestResult, activeReeval, cadenceDue);
  return {
    ownerResponseStatus:
      suppressed || projection.status === 'monitoring'
        ? 'not_required'
        : projection.lifecycleOwnerCatId || projection.ownerResponseRefs.length > 0
          ? 'acknowledged'
          : 'not_started',
    reevalStatus,
    stale,
    repairDebtStatus,
    reevalDebtStatus,
    ...(activeReeval && projection.reevalDueAt ? { reevalDueAt: projection.reevalDueAt } : {}),
    ...(projection.status === 'escalated' && projection.escalation ? { escalation: projection.escalation } : {}),
  };
}
