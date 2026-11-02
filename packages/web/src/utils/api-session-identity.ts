/** Observed HttpOnly-session identity, not a user preference or a caller-supplied authorization. */
export interface ApiSessionIdentity {
  ownerUserId: string | null;
  generation: number;
}
let snapshot: ApiSessionIdentity = { ownerUserId: null, generation: 0 };
const listeners = new Set<() => void>();
export const apiSessionIdentity = {
  getSnapshot: () => snapshot,
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
};
export function observeApiSessionOwner(owner: unknown): void {
  const ownerUserId = typeof owner === 'string' && owner.trim() ? owner : null;
  if (ownerUserId === snapshot.ownerUserId) return;
  snapshot = { ownerUserId, generation: snapshot.generation + 1 };
  for (const listener of listeners) listener();
}
