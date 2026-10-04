import type { DevelopmentReturnRegistrationV1 } from '@cat-cafe/shared';

/** Called inside the execution store's write transaction, never as a preflight-only check. */
export function assertDevelopmentReturnChain(
  next: DevelopmentReturnRegistrationV1,
  history: readonly DevelopmentReturnRegistrationV1[],
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
  if (
    !previous ||
    (previous.status !== 'delivered' && !(previous.status === 'retired' && previous.reason === 'delivery_failed'))
  ) {
    throw new Error('A terminal predecessor in this exact owner/Task return scope is required');
  }
  if (scope.some((state) => state.predecessorRegistrationId === previous.registrationId)) {
    throw new Error('This predecessor already has a successor; continue the latest return');
  }
  if (scope.some((state) => state.status !== 'delivered' && state.status !== 'retired')) {
    throw new Error('An active predecessor return already owns this owner/Task');
  }
}
