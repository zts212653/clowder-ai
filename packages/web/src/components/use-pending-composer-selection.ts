'use client';

import { type MutableRefObject, type RefObject, useLayoutEffect, useRef } from 'react';

export interface PendingComposerSelection {
  text: string;
  start: number;
  end: number;
  direction?: 'forward' | 'backward' | 'none';
  focus?: boolean;
}

interface SelectionOperation {
  selection: PendingComposerSelection;
  textarea: HTMLTextAreaElement;
}

function restoreSelection(operation: SelectionOperation, textareaRef: RefObject<HTMLTextAreaElement | null>): void {
  const { selection, textarea } = operation;
  if (textareaRef.current !== textarea || textarea.value !== selection.text) return;
  if (selection.focus !== false) textarea.focus();
  textarea.setSelectionRange(selection.start, selection.end, selection.direction);
}

/** One deferred restore, cancelled by the next real operation; never a selection polling loop. */
function restoreAfterNativeCommit(
  operation: SelectionOperation,
  deferred: MutableRefObject<SelectionOperation | null>,
  pending: MutableRefObject<PendingComposerSelection | null>,
  applySelection: () => void,
): () => void {
  deferred.current = operation;
  const events = ['pointerdown', 'keydown', 'input', 'compositionstart', 'focusin'] as const;
  const detach = () => {
    for (const event of events) document.removeEventListener(event, cancel, true);
  };
  const cancel = () => {
    if (deferred.current === operation) deferred.current = null;
    cancelScheduled();
    detach();
  };
  const commit = () => {
    detach();
    if (deferred.current !== operation) return;
    deferred.current = null;
    if (!pending.current) applySelection();
  };
  const unfocused = operation.selection.focus === false;
  const scheduled = unfocused ? window.requestAnimationFrame(commit) : window.setTimeout(commit, 0);
  const cancelScheduled = () => {
    if (unfocused) window.cancelAnimationFrame(scheduled);
    else window.clearTimeout(scheduled);
  };
  for (const event of events) document.addEventListener(event, cancel, true);
  // Retain the operation across effect replay or an unrelated commit, cancelling only this callback.
  return () => {
    cancelScheduled();
    detach();
  };
}

export function usePendingComposerSelection(
  input: string,
  textareaRef: RefObject<HTMLTextAreaElement | null>,
  pendingSelectionRef: MutableRefObject<PendingComposerSelection | null>,
  contextAttachmentCount: number,
): void {
  const deferred = useRef<SelectionOperation | null>(null);
  useLayoutEffect(() => {
    // Consume a queued DOM intent on its commit even if an attachment replacement changes neither
    // input nor count. Without a pending/deferred operation this effect does no work.
    void contextAttachmentCount;
    const selection = pendingSelectionRef.current ?? deferred.current?.selection;
    const textarea = textareaRef.current;
    if (!selection || !textarea) return;
    if (textarea.value !== selection.text || input !== selection.text) {
      deferred.current = null;
      return;
    }
    const operation = pendingSelectionRef.current ? { selection, textarea } : deferred.current;
    if (!operation || operation.textarea !== textarea) {
      deferred.current = null;
      return;
    }
    const applySelection = () => restoreSelection(operation, textareaRef);
    applySelection();
    if (pendingSelectionRef.current === selection) pendingSelectionRef.current = null;
    // Unfocused native commits need one frame; focused recall keeps its existing timeout backup.
    // Both operations survive unrelated React commits until execution or the person's next operation.
    return restoreAfterNativeCommit(operation, deferred, pendingSelectionRef, applySelection);
  });
}
