import { type MutableRefObject, type RefObject, useEffect } from 'react';
import { registerComposerDraftObserver } from './composer-draft-flush-registry';

/** Read-only presentation port over the mounted canonical draft owner. */
export function useComposerDraftObservation(input: {
  threadId?: string;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  revisionRef: MutableRefObject<number>;
  hydratedRef: MutableRefObject<boolean>;
  admissionsPendingRef: MutableRefObject<number>;
}) {
  const { threadId, textareaRef, revisionRef, hydratedRef, admissionsPendingRef } = input;
  useEffect(() => {
    if (!threadId) return;
    return registerComposerDraftObserver(threadId, () =>
      textareaRef.current
        ? {
            text: textareaRef.current.value,
            revision: revisionRef.current,
            ready: hydratedRef.current && admissionsPendingRef.current === 0,
          }
        : null,
    );
  }, [threadId, textareaRef, revisionRef, hydratedRef, admissionsPendingRef]);
}
