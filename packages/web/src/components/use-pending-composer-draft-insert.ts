'use client';

import type { ContextAttachment, MessageContent } from '@cat-cafe/shared';
import { type Dispatch, type MutableRefObject, type SetStateAction, useEffect } from 'react';
import type { ComposerDraftInsert } from '@/stores/chat-types';
import { useChatStore } from '@/stores/chatStore';
import { composerDraftSignature } from './durable-composer-draft-helpers';
import {
  applyContextAttachmentDelta,
  mergeContextAttachments,
  rebaseAuthoritativeText,
} from './durable-composer-draft-merge';
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
  setInput: Dispatch<SetStateAction<string>>;
  setContextAttachments: Dispatch<SetStateAction<ContextAttachment[]>>;
  restoreDraftImages: (urls: readonly string[], targetThreadId: string, authoritative: boolean) => Promise<void>;
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

function applyPendingContext(
  insert: ComposerDraftInsert,
  setContextAttachments: Dispatch<SetStateAction<ContextAttachment[]>>,
  contextAttachmentsRef: MutableRefObject<ContextAttachment[]>,
): void {
  if (!insert.contextAttachments && !insert.removeContextAttachmentIds && !insert.authoritative) return;
  setContextAttachments((current) => {
    const removedIds = new Set(insert.removeContextAttachmentIds ?? []);
    const next = insert.authoritative
      ? mergeContextAttachments(insert.contextAttachments ?? [], current)
      : applyContextAttachmentDelta(current, insert.contextAttachments ?? [], removedIds);
    contextAttachmentsRef.current = next;
    return next;
  });
}

function applyPendingReply(insert: ComposerDraftInsert): void {
  if (!insert.replyToId) return;
  const store = useChatStore.getState();
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
    applyPendingServerRevision(pendingChatInsert, refs);
    pendingSelectionRef.current = pendingChatInsert.selectionRange
      ? { text: pendingChatInsert.text, ...pendingChatInsert.selectionRange }
      : null;
    setInput((previous) => {
      const next = projectPendingText(pendingChatInsert, previous);
      if (!pendingChatInsert.selectionRange && pendingChatInsert.contextAttachments?.length) {
        pendingSelectionRef.current = { text: next, start: next.length, end: next.length };
      }
      return next;
    });
    applyPendingContext(pendingChatInsert, setContextAttachments, contextAttachmentsRef);
    void restoreDraftImages(
      pendingChatInsert.imageUrls ?? [],
      pendingChatInsert.threadId,
      pendingChatInsert.authoritative ?? false,
    );
    applyPendingReply(pendingChatInsert);
    setPendingChatInsert(null);
  }, [
    contextAttachmentsRef,
    hydratedRef,
    hydrationGenerationRef,
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
  ]);
}
