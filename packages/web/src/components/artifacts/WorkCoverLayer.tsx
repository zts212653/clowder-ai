'use client';
import { useEffect } from 'react';
import { useShellCopy } from '@/components/shell/shell-copy';
import { WorkCoverPicker } from './WorkCoverPicker';
import { workCoverCopy } from './work-cover.shell-copy';
import { saveWorkCover, WorkCoverRequestError } from './work-cover-client';
import { noticeAfterSave, returnFocus, UNDO_NOTICE_MS, useWorkCoverLayer } from './work-cover-layer-store';

/** One page-level layer for the cover picker and its undo notice, independent of any card's lifetime. */
export function WorkCoverLayer() {
  const t = useShellCopy(workCoverCopy);
  const { picker, notice, closePicker, showNotice, hideNotice } = useWorkCoverLayer();
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => {
      if (useWorkCoverLayer.getState().notice?.id === notice.id) hideNotice();
    }, UNDO_NOTICE_MS);
    return () => clearTimeout(timer);
  }, [notice, hideNotice]);
  const reference = picker?.artifact.work;
  return (
    <>
      {picker && reference && (
        <WorkCoverPicker
          artifact={picker.artifact}
          title={picker.title}
          version={reference.ownerRevision}
          view={picker.view}
          metadata={picker.metadata}
          onClose={() => {
            closePicker();
            returnFocus(picker.focus);
          }}
          onSaved={(saved, previous) => {
            closePicker();
            returnFocus(picker.focus);
            noticeAfterSave(reference, saved, previous, t.changed(reference.ownerRevision));
          }}
        />
      )}
      {notice && (
        <div className="work-cover-notice" role="status">
          <span>{notice.text}</span>
          {notice.undo && (
            <button
              type="button"
              className="shell-focusable"
              onClick={async () => {
                const undo = notice.undo!;
                hideNotice();
                try {
                  await saveWorkCover({
                    reference: undo.reference,
                    operationId: undo.operationId,
                    expectedCoverRevision: undo.expected,
                    choice: undo.choice,
                  });
                  showNotice(t.undone);
                } catch (cause) {
                  showNotice(t.failed(t.reasons[cause instanceof WorkCoverRequestError ? cause.code : 'other']));
                }
              }}
            >
              {t.undo}
            </button>
          )}
        </div>
      )}
    </>
  );
}
