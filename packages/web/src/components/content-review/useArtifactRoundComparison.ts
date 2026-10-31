import type { ArtifactReviewRound, ArtifactReviewView } from '@cat-cafe/shared';
import { useEffect, useState } from 'react';
import { useWorkspaceSurfaceVisibility } from '@/components/workbench/WorkspaceSurfaceVisibility';
import { useChatStore } from '@/stores/chatStore';
import {
  clearModificationFocus,
  type ModificationFocus,
  modificationFocusStanding,
  usePendingModificationFocus,
} from './modification-focus';
import { modificationReviewBinding } from './modification-review-binding';

/**
 * Whether a receipt's ask names this round. A request made on a published work or a Task round has no file: the
 * version a cat returned is a round of the original review, recognised by its own identity (the `contentRef` and
 * `ownerRevision` its asset carries) in the review the request is committed to. The comparison is against an
 * earlier round, so the first round never is one.
 */
export function asksForRound(focus: ModificationFocus, view: ArtifactReviewView, round: ArtifactReviewRound): boolean {
  const asset = focus.asset;
  if (!asset || !focus.candidateRef) return false;
  if (asset.contentRef !== round.asset.contentRef || asset.ownerRevision !== round.asset.ownerRevision) return false;
  // The same version can be a round of a sibling review, so the asset never says whose round this is: the review the
  // owner committed the request to does. Nothing that names no review, or names two, is taken as this one's.
  const binding = modificationReviewBinding(focus.record);
  if (binding.state !== 'bound' || binding.reviewId !== view.review.reviewId) return false;
  return view.review.rounds.some((item) => item.number < round.number);
}

/**
 * The round surface's comparison with an earlier version. The person can open it themselves, and that stays open
 * until they leave it. A receipt in the conversation can also ask for it: the ask is taken once, by the round it
 * names, and the comparison then belongs to the Workspace navigation that carried it (a newer navigation to the same
 * work shows the round again, nothing is cleared by hand), as the file surface does.
 */
export function useArtifactRoundComparison(
  view: ArtifactReviewView,
  round: ArtifactReviewRound,
  /** Called when the comparison opens, whichever way: the round's own panel and any playing video step aside. */
  onEnter: () => void,
) {
  const [byHand, setByHand] = useState(false);
  const [askedAt, setAskedAt] = useState<number | null>(null);
  const openRevision = useChatStore((state) => state.workspaceOpenRevision);
  const currentThreadId = useChatStore((state) => state.currentThreadId);
  const opening = useChatStore((state) => state.workspaceOpenRequest);
  const visible = useWorkspaceSurfaceVisibility();
  const pendingFocus = usePendingModificationFocus();

  useEffect(() => {
    // An old round can still be mounted while F307 opens/resolves the new destination.
    // Leave the accepted click for the visible round after that navigation has been consumed.
    if (!visible || opening || !pendingFocus) return;
    const standing = modificationFocusStanding(pendingFocus, { threadId: currentThreadId, revision: openRevision });
    if (standing !== 'ours' || !asksForRound(pendingFocus, view, round)) return;
    onEnter();
    setAskedAt(pendingFocus.navigation.revision);
    clearModificationFocus(pendingFocus);
  }, [pendingFocus, currentThreadId, openRevision, view, round, onEnter, opening, visible]);

  return {
    comparing: byHand || (askedAt !== null && askedAt === openRevision),
    open: () => {
      onEnter();
      setByHand(true);
    },
    close: () => {
      setByHand(false);
      setAskedAt(null);
    },
  };
}
