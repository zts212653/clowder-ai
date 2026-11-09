import type { LifecycleStoredMessageMetadata } from '@cat-cafe/shared';

/** Query predicate for a derived History index, never a second work or retry owner. */
export function hasUnresolvedLifecycleAppend(lifecycle: LifecycleStoredMessageMetadata | undefined): boolean {
  return (
    lifecycle?.dispatchRefs?.some((ref) => {
      if (ref.appendAcceptance !== 'pending' && ref.appendAcceptance !== 'written') return false;
      if (ref.inputRead?.status === 'read' && !ref.appendDelivery?.requiresCompletion) return false;
      const failure = lifecycle.appendFailures?.find(
        (item) => item.targetId === ref.targetId && item.responseMessageId === ref.statusMessageId,
      );
      if (failure && failure.acceptance !== 'unknown') return false;
      // Reading a native input proves receipt, but its own completion is still outstanding.
      if (
        ref.appendDelivery?.requiresCompletion &&
        (ref.inputRead?.status === 'read' || ref.appendAcceptance === 'written')
      )
        return true;
      return !failure || failure.checkedAt === undefined;
    }) ?? false
  );
}
