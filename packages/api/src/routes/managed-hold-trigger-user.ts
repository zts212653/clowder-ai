import { SYSTEM_USER_IDS } from '../domains/cats/services/stores/visibility.js';

type ManagedHoldThreadOwnerStore = {
  get(threadId: string): { createdBy: string } | null | Promise<{ createdBy: string } | null>;
};

/**
 * Managed command wakes execute later than the invocation that registered the hold.
 * An internal scheduler actor in a user-owned thread therefore inherits only that
 * server-owned thread's owner; arbitrary users and system-owned threads stay unchanged.
 */
export async function resolveManagedHoldTriggerUserId(input: {
  actorUserId: string;
  threadId: string;
  threadStore?: ManagedHoldThreadOwnerStore;
}): Promise<string> {
  if (!SYSTEM_USER_IDS.has(input.actorUserId) || !input.threadStore) return input.actorUserId;

  try {
    const thread = await input.threadStore.get(input.threadId);
    if (!thread || SYSTEM_USER_IDS.has(thread.createdBy)) return input.actorUserId;
    return thread.createdBy;
  } catch {
    return input.actorUserId;
  }
}
