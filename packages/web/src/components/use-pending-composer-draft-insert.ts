'use client';

import type { ContextAttachment, MessageContent } from '@cat-cafe/shared';
import { type Dispatch, type MutableRefObject, type RefObject, type SetStateAction, useEffect } from 'react';
import type { ComposerDraftInsert } from '@/stores/chat-types';
import { useChatStore } from '@/stores/chatStore';
import { useToastStore } from '@/stores/toastStore';
import { composerDraftSignature } from './durable-composer-draft-helpers';
import {
  applyContextAttachmentDelta,
  rebaseAuthoritativeContext,
  rebaseAuthoritativeImageUrls,
  rebaseAuthoritativeText,
} from './durable-composer-draft-merge';
import { readThreadDraftSelection } from './thread-drafts';
import type { DraftImageRestorationResult } from './use-durable-composer-draft-images';
import type { PendingComposerSelection } from './use-pending-composer-selection';

interface PendingComposerDraftRefs {
  hydrationGenerationRef: MutableRefObject<number>;
  imageUrlsRef: MutableRefObject<string[]>;
  revisionRef: MutableRefObject<number>;
  hydratedRef: MutableRefObject<boolean>;
  lastSavedSignatureRef: MutableRefObject<string>;
  preservedBlocksRef: MutableRefObject<MessageContent[]>;
  contextAttachmentsRef: MutableRefObject<ContextAttachment[]>;
  pendingSelectionRef: MutableRefObject<PendingComposerSelection | null>;
}

interface UsePendingComposerDraftInsertOptions extends PendingComposerDraftRefs {
  threadId?: string;
  hydrationSettledRef: MutableRefObject<Promise<void>>;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  setInput: Dispatch<SetStateAction<string>>;
  setContextAttachments: Dispatch<SetStateAction<ContextAttachment[]>>;
  restoreDraftImages: (
    urls: readonly string[],
    targetThreadId: string,
    authoritative: boolean,
  ) => Promise<DraftImageRestorationResult>;
}

function applyPendingServerRevision(insert: ComposerDraftInsert, refs: PendingComposerDraftRefs): void {
  if (insert.serverRevision === undefined) return;
  const imageUrls = insert.imageUrls ?? [];
  refs.imageUrlsRef.current = [...imageUrls];
  refs.revisionRef.current = insert.serverRevision;
  refs.hydratedRef.current = true;
  refs.lastSavedSignatureRef.current = composerDraftSignature(
    insert.text,
    imageUrls,
    insert.contextAttachments ?? [],
    refs.preservedBlocksRef.current,
    insert.replyToId,
  );
}

function projectPendingText(insert: ComposerDraftInsert, previous: string): string {
  if (insert.authoritative) return rebaseAuthoritativeText(insert.text, insert.clientSnapshot?.text, previous);
  if (!insert.text) return previous;
  const separator = previous && !previous.endsWith('\n') ? '\n' : '';
  return previous + separator + insert.text;
}

function keptDraftSelection(
  insert: ComposerDraftInsert,
  previous: string,
  next: string,
  textarea: HTMLTextAreaElement | null,
): PendingComposerSelection {
  const selection =
    textarea?.value === previous
      ? { start: textarea.selectionStart, end: textarea.selectionEnd, direction: textarea.selectionDirection }
      : readThreadDraftSelection(insert.threadId, previous);
  return {
    text: next,
    start: selection?.start ?? previous.length,
    end: selection?.end ?? previous.length,
    direction: selection?.direction,
    focus: false,
  };
}

function applyPendingContext(
  insert: ComposerDraftInsert,
  setContextAttachments: Dispatch<SetStateAction<ContextAttachment[]>>,
  contextAttachmentsRef: MutableRefObject<ContextAttachment[]>,
): void {
  if (!insert.contextAttachments && !insert.removeContextAttachmentIds && !insert.authoritative) return;
  setContextAttachments((current) => {
    const removedIds = new Set(insert.removeContextAttachmentIds ?? []);
    const next = insert.authoritative
      ? rebaseAuthoritativeContext(insert.contextAttachments ?? [], insert.clientSnapshot?.contextAttachments, current)
      : applyContextAttachmentDelta(current, insert.contextAttachments ?? [], removedIds);
    contextAttachmentsRef.current = next;
    return next;
  });
}

function applyPendingReply(insert: ComposerDraftInsert): void {
  const store = useChatStore.getState();
  if (insert.authoritative && insert.clientSnapshot) {
    if (store.replyToMessage?.id !== insert.clientSnapshot.replyToId) return;
    if (!insert.replyToId) {
      store.clearReplyTo();
      return;
    }
  }
  if (!insert.replyToId) return;
  const parent = store.messages.find((message) => message.id === insert.replyToId);
  store.setReplyTo({
    id: insert.replyToId,
    content: parent?.content ?? '(原消息未加载)',
    senderCatId: parent?.catId ?? null,
    threadId: insert.threadId,
  });
}

export function usePendingComposerDraftInsert({
  threadId,
  setInput,
  setContextAttachments,
  restoreDraftImages,
  hydrationGenerationRef,
  hydrationSettledRef,
  textareaRef,
  imageUrlsRef,
  revisionRef,
  hydratedRef,
  lastSavedSignatureRef,
  preservedBlocksRef,
  contextAttachmentsRef,
  pendingSelectionRef,
}: UsePendingComposerDraftInsertOptions): void {
  const pendingChatInsert = useChatStore((state) => state.pendingChatInsert);
  const setPendingChatInsert = useChatStore((state) => state.setPendingChatInsert);

  useEffect(() => {
    if (!pendingChatInsert || pendingChatInsert.threadId !== threadId) return;
    let active = true;
    const apply = () => {
      if (!active || useChatStore.getState().pendingChatInsert !== pendingChatInsert) return;
      hydrationGenerationRef.current += 1;
      const refs = {
        hydrationGenerationRef,
        imageUrlsRef,
        revisionRef,
        hydratedRef,
        lastSavedSignatureRef,
        preservedBlocksRef,
        contextAttachmentsRef,
        pendingSelectionRef,
      };
      const imageUrls = pendingChatInsert.authoritative
        ? rebaseAuthoritativeImageUrls(
            pendingChatInsert.imageUrls ?? [],
            pendingChatInsert.clientSnapshot?.imageUrls,
            imageUrlsRef.current,
          )
        : (pendingChatInsert.imageUrls ?? []);
      applyPendingServerRevision(pendingChatInsert, refs);
      pendingSelectionRef.current = pendingChatInsert.selectionRange
        ? { text: pendingChatInsert.text, ...pendingChatInsert.selectionRange }
        : null;
      setInput((previous) => {
        const next = projectPendingText(pendingChatInsert, previous);
        if (
          pendingChatInsert.preserveSelection &&
          !pendingChatInsert.authoritative &&
          !pendingChatInsert.selectionRange
        ) {
          pendingSelectionRef.current = keptDraftSelection(pendingChatInsert, previous, next, textareaRef.current);
        } else if (!pendingChatInsert.selectionRange && pendingChatInsert.contextAttachments?.length) {
          pendingSelectionRef.current = { text: next, start: next.length, end: next.length };
        }
        return next;
      });
      applyPendingContext(pendingChatInsert, setContextAttachments, contextAttachmentsRef);
      void restoreDraftImages(imageUrls, pendingChatInsert.threadId, pendingChatInsert.authoritative ?? false);
      applyPendingReply(pendingChatInsert);
      setPendingChatInsert(null);
    };
    if (pendingChatInsert.waitForDraft && !pendingChatInsert.authoritative) {
      // The owner's hydration effect installs its promise later in this commit.
      // Waiting a microtask avoids cancelling that read or inventing its revision.
      void Promise.resolve().then(async () => {
        await hydrationSettledRef.current;
        if (!active || useChatStore.getState().pendingChatInsert !== pendingChatInsert) return;
        if (!hydratedRef.current) {
          setPendingChatInsert(null);
          if (pendingChatInsert.draftReadFailure) {
            useToastStore.getState().addToast({ type: 'error', ...pendingChatInsert.draftReadFailure, duration: 6000 });
          }
          return;
        }
        apply();
      });
    } else apply();
    return () => {
      active = false;
    };
  }, [
    contextAttachmentsRef,
    hydratedRef,
    hydrationGenerationRef,
    hydrationSettledRef,
    imageUrlsRef,
    lastSavedSignatureRef,
    pendingChatInsert,
    pendingSelectionRef,
    preservedBlocksRef,
    restoreDraftImages,
    revisionRef,
    setContextAttachments,
    setInput,
    setPendingChatInsert,
    threadId,
    textareaRef,
  ]);
}
