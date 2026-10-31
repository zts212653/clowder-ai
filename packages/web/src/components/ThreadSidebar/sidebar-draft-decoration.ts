import { useCallback, useMemo, useSyncExternalStore } from 'react';
import { useChatStore } from '@/stores/chatStore';
import type { SidebarSnapshotRow } from '@/stores/sidebarProjectionStore';
import { hasPendingThreadDraft, subscribeContextAttachmentDrafts, subscribeThreadDrafts } from '../thread-drafts';
import { hasThreadRowSignals } from './ThreadRowSignals';
import type { GroupDecisionRead } from './use-group-decisions';

/** Both canonical draft notifications as one subscription: what changes a text draft or a context-attachment draft. */
function subscribeToDraftOwner(onChange: () => void): () => void {
  const stopText = subscribeThreadDrafts(onChange);
  const stopContext = subscribeContextAttachmentDrafts(onChange);
  return () => {
    stopText();
    stopContext();
  };
}

const noDraftOnTheServer = () => false;

/**
 * The sole named legacy decoration allowed into a Sidebar row (F297: a composer-owned local decoration, never part of the
 * Sidebar snapshot).
 *
 * Two readings of the same fact, either one shows the marker. The `hasDraft` flag is written by a composer while it is mounted for
 * that thread, so it exists only for threads opened in this page load. The draft's real owner, `thread-drafts`, is hydrated from
 * sessionStorage when the page loads and is what the composer writes first, so it also knows the drafts that survived a reload
 * for threads nobody has opened yet. Reading the owner here adds no state and no authority; it only stops the marker from
 * disappearing for a draft that is still there. Image drafts are in memory by design and are not in the owner after a reload.
 */
export function useSidebarDraftDecoration(threadId: string): boolean {
  const flagged = useChatStore(useCallback((state) => state.threadStates[threadId]?.hasDraft === true, [threadId]));
  const getOwnerSnapshot = useCallback(() => hasPendingThreadDraft(threadId), [threadId]);
  const kept = useSyncExternalStore(subscribeToDraftOwner, getOwnerSnapshot, noDraftOnTheServer);
  return flagged || kept;
}

/** Virtual rows use the same composer-owned draft truth as the visible decoration, including offscreen drafts. */
export function useSidebarRowHeight(
  rows: readonly SidebarSnapshotRow[],
  _currentId: string | null,
  compact: boolean,
  groupDecisions: GroupDecisionRead,
) {
  const ids = useMemo(() => (compact ? rows.map((row) => row.id) : []), [rows, compact]);
  const flagged = useChatStore(
    useCallback((state) => JSON.stringify(ids.filter((id) => state.threadStates[id]?.hasDraft === true)), [ids]),
  );
  const readOwner = useCallback(() => JSON.stringify(ids.filter(hasPendingThreadDraft)), [ids]);
  const kept = useSyncExternalStore(subscribeToDraftOwner, readOwner, () => '[]');
  const drafts = useMemo(
    () => new Set<string>([...(JSON.parse(flagged) as string[]), ...(JSON.parse(kept) as string[])]),
    [flagged, kept],
  );
  const decisions = groupDecisions.status === 'ready' ? groupDecisions.threadIds : new Set<string>();
  return useCallback(
    (row: SidebarSnapshotRow) => {
      if (!compact) return 80;
      return hasThreadRowSignals({
        presence: row.presence,
        unreadCount: row.unreadCount,
        hasUserMention: row.hasUserMention,
        hasDraft: drafts.has(row.id),
        hasPendingDecision: decisions.has(row.id),
      })
        ? 76
        : 52;
    },
    [compact, drafts, decisions],
  );
}
