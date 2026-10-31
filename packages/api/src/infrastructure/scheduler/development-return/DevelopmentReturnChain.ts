import type { DevelopmentReturnRegistrationV1 } from '@cat-cafe/shared';

/** Called inside the execution store's write transaction, never as a preflight-only check. */
export function assertDevelopmentReturnChain(
  next: DevelopmentReturnRegistrationV1,
  history: readonly DevelopmentReturnRegistrationV1[],
  activePredecessorRegistrationId?: string,
): void {
  const scope = history.filter(
    (state) =>
      state.ownerUserId === next.ownerUserId &&
      state.ownerThreadId === next.ownerThreadId &&
      state.ownerCatId === next.ownerCatId &&
      state.taskRef === next.taskRef,
  );
  if (!next.predecessorRegistrationId) {
    if (scope.length) throw new Error('An explicit terminal predecessor is required for this owner/Task return');
    return;
  }
  const previous = scope.find((state) => state.registrationId === next.predecessorRegistrationId);
  if (!previous) {
    throw new Error('A terminal predecessor in this exact owner/Task return scope is required');
  }
  const terminalPredecessor =
    previous.status === 'delivered' ||
    (previous.status === 'retired' && ['delivery_failed', 'superseded'].includes(previous.reason ?? ''));
  const activeSupersession =
    previous.registrationId === activePredecessorRegistrationId &&
    previous.status === 'waiting' &&
    previous.reason === undefined &&
    previous.report === undefined &&
    previous.wakeMessageId === undefined &&
    previous.deliveryRevision === undefined;
  if (!terminalPredecessor && !activeSupersession) {
    throw new Error('A terminal predecessor or eligible active supersession in this owner/Task scope is required');
  }
  if (scope.some((state) => state.predecessorRegistrationId === previous.registrationId)) {
    throw new Error('This predecessor already has a successor; continue the latest return');
  }
  if (
    scope.some(
      (state) =>
        state.status !== 'delivered' &&
        state.status !== 'retired' &&
        (!activeSupersession || state.registrationId !== previous.registrationId),
    )
  ) {
    throw new Error('An active predecessor return already owns this owner/Task');
  }
}
