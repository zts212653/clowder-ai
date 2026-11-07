'use client';
import type { ThreadArtifactDTO } from '@cat-cafe/shared';
import { ReviewToolbarIcon } from '@/components/content-review/ReviewToolbarIcon';
import { useShellCopy } from '@/components/shell/shell-copy';
import { useWorkCover } from './useWorkCover';
import { workCoverCopy } from './work-cover.shell-copy';
import { saveWorkCover, WorkCoverRequestError } from './work-cover-client';
import { type FocusReturn, noticeAfterSave, useWorkCoverLayer } from './work-cover-layer-store';

/**
 * The one cover action set for a fixed video work version, placed in the card's "⋯" and in the opened
 * work's "⋯" alike. The picker and undo notice live in the page-level WorkCoverLayer, so a list refresh
 * that replaces the card never drops a selection or an undo offer.
 */
export function WorkCoverMenuItems({
  artifact,
  title,
  metadata,
  focusReturn,
}: {
  artifact: ThreadArtifactDTO;
  title: string;
  metadata?: string;
  /** Where focus goes after the picker closes; read when the action starts. */
  focusReturn: () => FocusReturn | null;
}) {
  const t = useShellCopy(workCoverCopy);
  const reference = artifact.work;
  const { view } = useWorkCover(reference, !!reference);
  if (!reference || !view) return null;
  const open = () => useWorkCoverLayer.getState().openPicker({ artifact, title, metadata, view, focus: focusReturn() });
  const clear = async () => {
    try {
      const saved = await saveWorkCover({
        reference,
        operationId: crypto.randomUUID(),
        expectedCoverRevision: view.coverRevision,
        choice: { mode: 'frame' },
      });
      noticeAfterSave(reference, saved, view, t.cleared(reference.ownerRevision));
    } catch (cause) {
      useWorkCoverLayer
        .getState()
        .showNotice(t.failed(t.reasons[cause instanceof WorkCoverRequestError ? cause.code : 'other']));
    }
  };
  return (
    <div className="work-cover-menu-group">
      <button role="menuitem" type="button" onClick={open}>
        <ReviewToolbarIcon name="image" />
        {view.state === 'image' ? t.change : view.state === 'unavailable' ? t.unreadable : t.set}
      </button>
      {(view.state === 'image' || view.state === 'unavailable') && (
        <button role="menuitem" type="button" onClick={() => void clear()}>
          <ReviewToolbarIcon name="close" />
          {t.clear}
        </button>
      )}
    </div>
  );
}
