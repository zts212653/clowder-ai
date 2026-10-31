import type { ApprovalHubItem } from '@cat-cafe/shared';
import { apiFetch } from '@/utils/api-client';
import { apiSessionIdentity } from '@/utils/api-session-identity';

interface PendingReadState {
  items: ApprovalHubItem[];
  count: number;
  isLoading: boolean;
  error: string | null;
  pendingOwnerUserId: string | null;
  pendingReadAvailable: boolean;
  pendingRequestVersion: number;
  fetchPending: () => Promise<void>;
}
type SetPending = (
  update: Partial<PendingReadState> | ((state: PendingReadState) => Partial<PendingReadState>),
) => void;

/** One synchronization point for the existing pending store. Display consumers join; writer confirmations remain fresh. */
export function createApprovalPendingRead(set: SetPending, get: () => PendingReadState) {
  let latestPendingRead: Promise<void> | undefined;
  let pendingEventsInstalled = false;
  function installPendingReadEvents() {
    if (pendingEventsInstalled || typeof window === 'undefined') return;
    pendingEventsInstalled = true;
    let queued = false;
    const invalidate = () => {
      if (queued) return;
      queued = true;
      actions.invalidatePending();
      queueMicrotask(() => {
        queued = false;
      });
    };
    for (const name of [
      'cat-cafe:proposal-updated',
      'cat-cafe:proposal-created',
      'cat-cafe:runtime-interaction-updated',
    ])
      window.addEventListener(name, invalidate);
  }
  const actions = {
    invalidatePending: () => {
      latestPendingRead = undefined;
      set((state) => ({
        pendingRequestVersion: state.pendingRequestVersion + 1,
        pendingReadAvailable: false,
        isLoading: false,
      }));
    },
    fetchPending: async () => {
      installPendingReadEvents();
      const requestVersion = get().pendingRequestVersion + 1;
      const owner = apiSessionIdentity.getSnapshot().ownerUserId ?? get().pendingOwnerUserId;
      const read = (async () => {
        const itemsAtRequest = get().items;
        set({
          pendingRequestVersion: requestVersion,
          pendingOwnerUserId: owner,
          isLoading: true,
          pendingReadAvailable: false,
          error: null,
        });
        try {
          // A refresh can follow a proposal event or decision while an earlier
          // read is still in flight. Join the bounded trailing generation so its
          // pre-change snapshot cannot satisfy the new refresh.
          const res = await apiFetch('/api/approval-hub/pending', undefined, { afterCurrentGet: true });
          if (!res.ok) throw new Error(`Failed to fetch: ${res.status}`);
          const data = (await res.json()) as {
            items: ApprovalHubItem[];
            count: number;
            identity?: { ownerUserId: string };
          };
          if (get().pendingRequestVersion !== requestVersion) return;
          if (
            owner &&
            ((data.identity && data.identity.ownerUserId !== owner) ||
              data.items.some((item) => item.ownerUserId !== owner))
          )
            throw new Error('Pending approval owner mismatch');
          // A decision may have removed or updated an item after this GET began.
          // Re-read canonical state rather than restoring the pre-decision snapshot.
          if (get().items !== itemsAtRequest) return get().fetchPending();
          set({
            items: data.items,
            count: data.count,
            pendingOwnerUserId: data.identity?.ownerUserId ?? owner,
            isLoading: false,
            pendingReadAvailable: true,
          });
        } catch (err) {
          if (get().pendingRequestVersion !== requestVersion) return;
          set({
            error: err instanceof Error ? err.message : 'Unknown error',
            isLoading: false,
            pendingReadAvailable: false,
          });
        }
      })();
      if (get().pendingRequestVersion === requestVersion) latestPendingRead = read;
      let observed = read;
      await observed;
      // An earlier physical response cannot complete a caller while a newer canonical read is still pending.
      while (latestPendingRead && latestPendingRead !== observed) {
        observed = latestPendingRead;
        await observed;
      }
    },

    ensurePending: async (owner: string) => {
      const state = get();
      if (
        state.pendingReadAvailable &&
        !state.isLoading &&
        (!state.pendingOwnerUserId || state.pendingOwnerUserId === owner) &&
        state.items.every((item) => item.ownerUserId === owner)
      ) {
        if (!state.pendingOwnerUserId) set({ pendingOwnerUserId: owner });
        return;
      }
      if (state.isLoading && state.pendingOwnerUserId === owner && latestPendingRead) {
        await latestPendingRead;
        return;
      }
      set({ pendingOwnerUserId: owner });
      await get().fetchPending();
    },
  };
  return actions;
}
