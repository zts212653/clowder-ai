import { compareReevalCycles } from './reeval-case-cycle-order.js';
import type { ReevalCaseCycleRoot, ReevalCaseResponsibilityBlocker } from './reeval-case-types.js';
import { ReevalClosureProjectionError } from './reeval-closure.js';
import type { EvalLifecycleEvent, EvalVerdictLifecycleStatus } from './reeval-closure-schema.js';

export const TERMINAL_CASE_STATUSES = new Set<EvalVerdictLifecycleStatus>(['resolved', 'suppressed_with_reason']);

export function requireCaseRootValue(value: string | undefined, field: string): string {
  if (!value?.trim()) {
    throw new ReevalClosureProjectionError('invalid_root', `case root ${field} must be non-empty`);
  }
  return value;
}

export function requireCaseOwner(event: EvalLifecycleEvent, ownerCatId: string | undefined): void {
  if (!ownerCatId || event.actor.kind !== 'cat' || event.actor.id !== ownerCatId) {
    throw new ReevalClosureProjectionError(
      'authority_mismatch',
      `${event.type} actor must match active lifecycle owner ${ownerCatId ?? 'unavailable'}`,
    );
  }
}

export function illegalCaseTransition(status: EvalVerdictLifecycleStatus, event: EvalLifecycleEvent): never {
  throw new ReevalClosureProjectionError(
    'illegal_transition',
    `illegal transition: ${event.type} cannot follow ${status}`,
  );
}

export function requireCaseAutomation(event: EvalLifecycleEvent): void {
  if (event.actor.kind !== 'automation') {
    throw new ReevalClosureProjectionError('authority_mismatch', `${event.type} requires automation`);
  }
}

export function projectResponsibilityBlocker(
  event: Extract<EvalLifecycleEvent, { type: 'responsibility_blocked' }>,
): ReevalCaseResponsibilityBlocker {
  const { eventId, reasonCode, featureId, ownerCatId, candidateThreadIds } = event;
  const candidateCount = new Set(candidateThreadIds).size;
  if (
    candidateCount !== candidateThreadIds.length ||
    (reasonCode === 'feature_thread_not_found' && candidateCount !== 0) ||
    (reasonCode === 'feature_thread_ambiguous' && candidateCount < 2)
  ) {
    throw new ReevalClosureProjectionError(
      'identity_mismatch',
      'responsibility blocker candidates must match the feature-thread resolution outcome',
    );
  }
  return { eventId, reasonCode, featureId, ownerCatId, candidateThreadIds };
}

export function requireCaseMigration(event: EvalLifecycleEvent): void {
  if (event.actor.kind !== 'migration' || event.actor.id !== 'f266-legacy-v1-case-migration') {
    throw new ReevalClosureProjectionError(
      'authority_mismatch',
      `${event.type} requires the audited migration principal`,
    );
  }
}

export function assertLegacyCaseMigration(
  event: Extract<EvalLifecycleEvent, { type: 'legacy_case_migrated' }>,
  cycles: ReadonlyMap<string, ReevalCaseCycleRoot>,
  hasObservedCycles: boolean,
): void {
  requireCaseMigration(event);
  if (hasObservedCycles) {
    throw new ReevalClosureProjectionError('invalid_history', 'legacy case migration must be the first event');
  }
  const uniqueVerdictIds = new Set(event.legacyVerdictIds);
  const activeCycle = cycles.get(event.verdictId);
  if (
    uniqueVerdictIds.size !== event.legacyVerdictIds.length ||
    !event.legacyVerdictIds.includes(event.verdictId) ||
    event.legacyVerdictIds.some((verdictId) => !cycles.has(verdictId))
  ) {
    throw new ReevalClosureProjectionError(
      'identity_mismatch',
      'legacy migration must reference unique registered verdict cycles',
    );
  }
  const expectedVerdictIds = [...cycles.values()]
    .filter((cycle) => activeCycle !== undefined && compareReevalCycles(cycle, activeCycle) <= 0)
    .sort(compareReevalCycles)
    .map((cycle) => cycle.verdictId);
  if (
    expectedVerdictIds.length !== event.legacyVerdictIds.length ||
    expectedVerdictIds.some((verdictId, index) => event.legacyVerdictIds[index] !== verdictId)
  ) {
    throw new ReevalClosureProjectionError(
      'identity_mismatch',
      'legacy migration must match the immutable cycle prefix through the reviewed verdict',
    );
  }
  if (
    !activeCycle ||
    Date.parse(event.reviewedAt) < Date.parse(activeCycle.createdAt) ||
    Date.parse(event.reviewedAt) > Date.parse(event.occurredAt)
  ) {
    throw new ReevalClosureProjectionError(
      'identity_mismatch',
      'legacy migration review time must follow the reviewed verdict and precede persistence',
    );
  }
  const expectedDisposition = activeCycle.verdict === 'keep_observe' ? 'monitor' : 'repair';
  if (event.disposition !== expectedDisposition) {
    throw new ReevalClosureProjectionError(
      'identity_mismatch',
      'legacy migration disposition does not match the reviewed active cycle',
    );
  }
}
