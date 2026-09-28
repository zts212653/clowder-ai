import type { PawFeelDispositionEvent, PawFeelDispositionProjection } from '@cat-cafe/shared';
import { derivePawFeelResumeConditionId } from '../blocker-recovery/resume-condition.js';

function fail(message: string): never {
  throw new Error(`paw-feel projection: ${message}`);
}

export function assertBlockedResumeCondition(
  projection: PawFeelDispositionProjection,
  event: Extract<PawFeelDispositionEvent, { type: 'blocked' }>,
): void {
  if (!event.resumeCondition) return;
  const episode = event.resumeCondition.blockedEpisode;
  if (
    episode.ownerFeatureId !== 'F278' ||
    episode.ownerStateRef !== `paw-feel-blocked:${projection.signalId}` ||
    episode.version !== String(projection.sequence + 1) ||
    event.resumeCondition.conditionId !== derivePawFeelResumeConditionId(episode, event.resumeCondition.selector)
  ) {
    fail('blocked resume condition does not match the active signal episode');
  }
}

export function transitionRepairOutcome(
  projection: PawFeelDispositionProjection,
  event: Extract<PawFeelDispositionEvent, { type: 'repair_outcome_linked' }>,
): PawFeelDispositionProjection {
  if (projection.state !== 'fix') fail(`illegal transition: ${projection.state} --${event.type}--> ?`);
  if (projection.repairOutcome) fail('verified repair outcome is terminal');
  if (!projection.directRepairBinding) fail('repair outcome requires a direct repair binding');
  if (JSON.stringify(event.outcome.bindingRef) !== JSON.stringify(projection.directRepairBinding.bindingRef)) {
    fail('repair outcome binding differs from the active fix binding');
  }
  if (event.actor.kind !== 'cat' || event.actor.id !== projection.ownerCatId) {
    fail('repair outcome requires the bound owner actor');
  }
  return { ...projection, repairOutcome: event.outcome };
}

export function transitionBlockerReopened(
  projection: PawFeelDispositionProjection,
  event: Extract<PawFeelDispositionEvent, { type: 'blocker_reopened' }>,
): PawFeelDispositionProjection {
  if (projection.state !== 'blocked') fail(`illegal transition: ${projection.state} --${event.type}--> ?`);
  if (event.actor.kind !== 'automation' && event.actor.kind !== 'migration') {
    fail('blocker reopen requires automation or migration actor');
  }
  if (event.reopen.kind === 'condition') {
    const condition = projection.blocker?.resumeCondition;
    if (
      !condition ||
      condition.conditionId !== event.reopen.conditionId ||
      condition.blockedVersion !== event.reopen.blockedVersion
    ) {
      fail('blocker reopen does not match the active condition');
    }
  } else if (projection.sequence !== event.reopen.blockingSequence) {
    fail('legacy blocker reopen does not match the blocking sequence');
  }
  const { blocker: _blocker, ...reopened } = projection;
  return { ...reopened, state: 'seen' };
}
