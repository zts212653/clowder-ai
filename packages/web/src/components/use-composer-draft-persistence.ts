'use client';

import type { ContextAttachment, MessageContent } from '@cat-cafe/shared';
import { type Dispatch, type MutableRefObject, type SetStateAction, useCallback } from 'react';
import { useChatStore } from '@/stores/chatStore';
import type { loadOwnerComposerDraft } from '@/utils/true-recall';
import type { ComposerAdmissionSnapshot } from './composer-draft-admission';
import {
  composerDraftSignature,
  contextAttachmentsFromDraft,
  type DurableDraftSnapshot,
  durableDraftSnapshotFromOwner,
  imageUrlsFromDraft,
  mergeHydratedDraft,
  preservedBlocksFromDraft,
  writeOwnerComposerDraft,
} from './durable-composer-draft-helpers';
import { mergeContextAttachments } from './durable-composer-draft-merge';
import { enqueueComposerDraftSave } from './durable-composer-draft-save-queue';
import type { useDurableComposerDraftImageState } from './use-durable-composer-draft-images';

export interface PendingComposerRecovery {
  snapshot: DurableDraftSnapshot;
  revision: number;
  source: 'hydration' | 'conflict';
}

interface DraftPersistenceOptions {
  threadId?: string;
  ownerIdRef: MutableRefObject<number>;
  revisionRef: MutableRefObject<number>;
  lastSavedSignatureRef: MutableRefObject<string>;
  canonicalDraftRef: MutableRefObject<DurableDraftSnapshot | null>;
  pendingRecoveryRef: MutableRefObject<PendingComposerRecovery | null>;
  preservedBlocksRef: MutableRefObject<MessageContent[]>;
  hydratedRef: MutableRefObject<boolean>;
  admissionsPendingRef: MutableRefObject<number>;
  clearFallbackRef: MutableRefObject<(ComposerAdmissionSnapshot & { imageUrls: string[] }) | null>;
  captureCurrentDraft: () => DurableDraftSnapshot;
  setInput: Dispatch<SetStateAction<string>>;
  setContextAttachments: Dispatch<SetStateAction<ContextAttachment[]>>;
  setReplyTo: ReturnType<typeof useChatStore.getState>['setReplyTo'];
  restoreFallbackImages: ReturnType<typeof useDurableComposerDraftImageState>['restoreFallbackImages'];
  restoreDraftImages: ReturnType<typeof useDurableComposerDraftImageState>['restoreDraftImages'];
  saveCurrentDraftForImagesRef: MutableRefObject<() => Promise<boolean>>;
}

/** Persistence uses the existing owner refs; admission alone consumes a captured recovery. */
export function useComposerDraftPersistence(options: DraftPersistenceOptions) {
  const {
    threadId,
    ownerIdRef,
    revisionRef,
    lastSavedSignatureRef,
    canonicalDraftRef,
    pendingRecoveryRef,
    preservedBlocksRef,
    hydratedRef,
    admissionsPendingRef,
    clearFallbackRef,
    captureCurrentDraft,
    setInput,
    setContextAttachments,
    setReplyTo,
    restoreFallbackImages,
    restoreDraftImages,
    saveCurrentDraftForImagesRef,
  } = options;

  const restoreAdmissionFallback = useCallback(() => {
    const fallback = clearFallbackRef.current;
    if (!fallback) return;
    setInput((current) => mergeHydratedDraft(current, fallback.text));
    restoreFallbackImages(fallback.images, fallback.imageUrls);
    setContextAttachments((current) => mergeContextAttachments(current, fallback.contextAttachments));
    if (fallback.replyTo && !useChatStore.getState().replyToMessage) setReplyTo(fallback.replyTo);
  }, [clearFallbackRef, restoreFallbackImages, setContextAttachments, setInput, setReplyTo]);

  const reconcileConflict = useCallback(
    (
      draft: Awaited<ReturnType<typeof loadOwnerComposerDraft>>,
      shouldClear: boolean,
      saveOwnerId?: number,
      saveThreadId?: string | null,
    ) => {
      // P1 R7: Verify owner if this conflict is from a queued save
      if (saveOwnerId !== undefined && saveThreadId !== undefined) {
        if (saveOwnerId !== ownerIdRef.current || saveThreadId !== threadId) {
          // Stale conflict from old owner - don't pollute current owner's state
          return;
        }
      }

      revisionRef.current = draft.revision;
      const currentImages = imageUrlsFromDraft(draft.draft);
      const currentContextAttachments = contextAttachmentsFromDraft(draft.draft);
      preservedBlocksRef.current = preservedBlocksFromDraft(draft.draft);
      canonicalDraftRef.current = durableDraftSnapshotFromOwner(draft.draft);
      const conflictSignature = composerDraftSignature(
        draft.draft?.text ?? '',
        currentImages,
        currentContextAttachments,
        preservedBlocksRef.current,
        draft.draft?.replyTo,
      );
      lastSavedSignatureRef.current = conflictSignature;
      void restoreDraftImages(currentImages, threadId ?? '', false);
      if (!shouldClear) {
        // Mark as pending recovery - not yet displayed
        if (canonicalDraftRef.current) {
          pendingRecoveryRef.current = {
            snapshot: canonicalDraftRef.current,
            revision: draft.revision,
            source: 'conflict',
          };
        }
        return;
      }
      setInput((localText) => mergeHydratedDraft(draft.draft?.text ?? '', localText));
      setContextAttachments((local) => mergeContextAttachments(currentContextAttachments, local));
      if (draft.draft?.replyTo && !useChatStore.getState().replyToMessage) {
        const store = useChatStore.getState();
        const parent = store.messages.find((message) => message.id === draft.draft?.replyTo);
        setReplyTo({
          id: draft.draft.replyTo,
          content: parent?.content ?? '(原消息未加载)',
          senderCatId: parent?.catId ?? null,
          threadId: threadId ?? '',
        });
      }
      // Displayed, so mark as pending recovery
      if (canonicalDraftRef.current) {
        pendingRecoveryRef.current = {
          snapshot: canonicalDraftRef.current,
          revision: draft.revision,
          source: 'conflict',
        };
      }
      clearFallbackRef.current = null;
    },
    [
      canonicalDraftRef,
      clearFallbackRef,
      lastSavedSignatureRef,
      ownerIdRef,
      pendingRecoveryRef,
      preservedBlocksRef,
      restoreDraftImages,
      revisionRef,
      setContextAttachments,
      setInput,
      setReplyTo,
      threadId,
    ],
  );

  const persistDraftSnapshot = useCallback(
    async (
      snapshot: DurableDraftSnapshot,
      allowPendingAdmission = false,
      boundOwnerId?: number,
      boundThreadId?: string | null,
    ) => {
      // P1 R7: Use bound owner ID if provided, otherwise current
      const capturedOwnerId = boundOwnerId ?? ownerIdRef.current;
      const capturedThreadId = boundThreadId ?? threadId;

      if (!capturedThreadId || (admissionsPendingRef.current > 0 && !allowPendingAdmission)) return false;

      // P1 R7: Validate owner identity at execution time
      if (boundOwnerId !== undefined) {
        if (capturedOwnerId !== ownerIdRef.current || capturedThreadId !== threadId) {
          // Owner changed - don't execute stale task
          return false;
        }
      }

      const signature = composerDraftSignature(
        snapshot.text,
        snapshot.imageUrls,
        snapshot.contextAttachments,
        snapshot.preservedBlocks,
        snapshot.replyTo,
      );
      if (signature === lastSavedSignatureRef.current) return true;

      // P1-1: Block autosave if there's unseen recovery, unless it's from hydration and user has seen it
      if (!allowPendingAdmission && pendingRecoveryRef.current) {
        // Allow autosave if recovery is from hydration and user has been editing (hydratedRef=true)
        if (pendingRecoveryRef.current.source === 'hydration' && hydratedRef.current) {
          // User saw hydration and is now editing - clear the old recovery and allow save
          pendingRecoveryRef.current = null;
        } else {
          // Conflict recovery or hydration not yet seen - block save
          return false;
        }
      }

      const shouldClear =
        !snapshot.text.trim() &&
        snapshot.imageUrls.length === 0 &&
        snapshot.contextAttachments.length === 0 &&
        snapshot.preservedBlocks.length === 0 &&
        !snapshot.replyTo;

      // P1 R7: Read current revision dynamically, not frozen at enqueue time
      const result = await writeOwnerComposerDraft(capturedThreadId, revisionRef.current, snapshot);

      // P1 R7: Always validate owner after async write
      if (capturedOwnerId !== ownerIdRef.current || capturedThreadId !== threadId) {
        return false; // Owner changed - discard stale save result
      }

      if (result.kind === 'conflict') {
        reconcileConflict(result, shouldClear, capturedOwnerId, capturedThreadId);
        return false;
      }
      if (result.kind === 'failed') {
        if (shouldClear) restoreAdmissionFallback();
        return false;
      }
      revisionRef.current = result.revision;
      lastSavedSignatureRef.current = signature;
      canonicalDraftRef.current = snapshot;
      clearFallbackRef.current = null;
      return true;
    },
    [
      admissionsPendingRef,
      canonicalDraftRef,
      clearFallbackRef,
      hydratedRef,
      lastSavedSignatureRef,
      ownerIdRef,
      pendingRecoveryRef,
      reconcileConflict,
      restoreAdmissionFallback,
      revisionRef,
      threadId,
    ],
  );

  const persistCurrentDraft = useCallback(() => {
    // P1 R7: Capture owner identity and snapshot, let revision advance dynamically
    const ownerContext = {
      ownerId: ownerIdRef.current,
      threadId: threadId,
      snapshot: captureCurrentDraft(),
    };

    if (!ownerContext.threadId) return Promise.resolve(false);

    return persistDraftSnapshot(ownerContext.snapshot, false, ownerContext.ownerId, ownerContext.threadId);
  }, [captureCurrentDraft, ownerIdRef, persistDraftSnapshot, threadId]);

  // P1 R9: Image save must capture owner at assignment, not at call time
  saveCurrentDraftForImagesRef.current = threadId
    ? () => {
        const ownerId = ownerIdRef.current;
        const capturedThreadId = threadId;
        const snapshot = captureCurrentDraft();
        return enqueueComposerDraftSave(threadId, () =>
          persistDraftSnapshot(snapshot, false, ownerId, capturedThreadId),
        );
      }
    : async () => false;

  return { persistDraftSnapshot, persistCurrentDraft };
}
