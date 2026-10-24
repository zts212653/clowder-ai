'use client';

import type { ContextAttachment, MessageContent } from '@cat-cafe/shared';
import { type Dispatch, type RefObject, type SetStateAction, useCallback, useEffect, useRef, useState } from 'react';
import { useChatStore } from '@/stores/chatStore';
import { loadOwnerComposerDraft } from '@/utils/true-recall';
import {
  type ComposerAdmissionReply,
  type ComposerAdmissionSnapshot,
  durableDraftForAdmission,
} from './composer-draft-admission';
import { useComposerDraftConsumption } from './composer-draft-consumption';
import { composerAttachments, queuedServerAckBlocks } from './composer-queue';
import {
  type PendingComposerAdmissionDraft,
  registerDurableComposerDraftAdmissionFlusher,
} from './durable-composer-draft-admission-flusher';
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
import { enqueueComposerDraftSave, waitForComposerDraftSaves } from './durable-composer-draft-save-queue';
import { useComposerDraftAutosave } from './use-composer-draft-autosave';
import { useComposerDraftObservation } from './use-composer-draft-observation';
import { useDurableComposerDraftImageState } from './use-durable-composer-draft-images';
import { usePendingComposerDraftInsert } from './use-pending-composer-draft-insert';
import { type PendingComposerSelection, usePendingComposerSelection } from './use-pending-composer-selection';
import { useThreadDraftSelection } from './use-thread-draft-selection';

interface UseDurableComposerDraftOptions {
  threadId?: string;
  input: string;
  setInput: Dispatch<SetStateAction<string>>;
  images: File[];
  setImages: Dispatch<SetStateAction<File[]>>;
  contextAttachments: ContextAttachment[];
  setContextAttachments: Dispatch<SetStateAction<ContextAttachment[]>>;
  replyToMessage: ComposerAdmissionReply | null;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  setIsPreparingImages: Dispatch<SetStateAction<boolean>>;
}

export function useDurableComposerDraft({
  threadId,
  input,
  setInput,
  images,
  setImages,
  contextAttachments,
  setContextAttachments,
  replyToMessage,
  textareaRef,
  setIsPreparingImages,
}: UseDurableComposerDraftOptions) {
  const setReplyTo = useChatStore((state) => state.setReplyTo);
  const inputRef = useRef(input);
  const revisionRef = useRef(0);
  const hydratedRef = useRef(false);
  const hydrationSettledRef = useRef<Promise<void>>(Promise.resolve());
  const lastSavedSignatureRef = useRef('');
  const hydrationGenerationRef = useRef(0);
  const ownerIdRef = useRef(0); // P1 R7: Stable owner identity, independent of hydration cancellation
  const contextAttachmentsRef = useRef<ContextAttachment[]>(contextAttachments);
  const preservedBlocksRef = useRef<MessageContent[]>([]);
  const replyToIdRef = useRef(replyToMessage?.id);
  const admissionsPendingRef = useRef(0);
  const pendingAdmissionDraftRef = useRef<PendingComposerAdmissionDraft | null>(null);
  const canonicalDraftRef = useRef<DurableDraftSnapshot | null>(null);
  const pendingRecoveryRef = useRef<{
    snapshot: DurableDraftSnapshot;
    revision: number;
    source: 'hydration' | 'conflict';
  } | null>(null);
  const recoveredDraftAwaitingConfirmationRef = useRef(false);
  const clearFallbackRef = useRef<(ComposerAdmissionSnapshot & { imageUrls: string[] }) | null>(null);
  const pendingSelectionRef = useRef<PendingComposerSelection | null>(null);
  const [admissionEpoch, setAdmissionEpoch] = useState(0);
  useComposerDraftConsumption(threadId, revisionRef, canonicalDraftRef, lastSavedSignatureRef);
  const saveCurrentDraftForImagesRef = useRef<() => Promise<boolean>>(async () => false);
  const {
    admissionImagesReady,
    discardUnrestoredImages,
    imageUrlsRef,
    removeImage,
    resetImageRecovery,
    restoreDraftImages,
    restoreFallbackImages,
    retryUnrestoredImages,
    unrestoredImageCount,
  } = useDurableComposerDraftImageState({
    threadId,
    ownerIdRef,
    setImages,
    setIsPreparingImages,
    saveCurrentDraftRef: saveCurrentDraftForImagesRef,
  });

  usePendingComposerDraftInsert({
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
  });

  usePendingComposerSelection(input, textareaRef, pendingSelectionRef, contextAttachments.length);
  useThreadDraftSelection(threadId, input, textareaRef);
  useEffect(() => {
    inputRef.current = input;
    contextAttachmentsRef.current = contextAttachments;
    replyToIdRef.current = replyToMessage?.id;
  }, [contextAttachments, input, replyToMessage?.id]);

  useEffect(() => {
    if (!threadId) return;
    const generation = ++hydrationGenerationRef.current;
    ++ownerIdRef.current; // P1 R7: Increment owner ID on thread switch only
    hydratedRef.current = false;
    canonicalDraftRef.current = null;
    pendingRecoveryRef.current = null;
    admissionsPendingRef.current = 0; // Reset pending count for new owner
    pendingAdmissionDraftRef.current = null;
    revisionRef.current = 0; // Reset revision for new owner
    lastSavedSignatureRef.current = ''; // Reset signature for new owner
    resetImageRecovery();
    recoveredDraftAwaitingConfirmationRef.current = false;
    const hydration = waitForComposerDraftSaves(threadId)
      .then(() => loadOwnerComposerDraft(threadId))
      .then(async ({ draft, revision }) => {
        if (hydrationGenerationRef.current !== generation) return;
        const serverText = draft?.text ?? '';
        const imageUrls = imageUrlsFromDraft(draft);
        const serverContextAttachments = contextAttachmentsFromDraft(draft);
        preservedBlocksRef.current = preservedBlocksFromDraft(draft);
        canonicalDraftRef.current = durableDraftSnapshotFromOwner(draft);
        revisionRef.current = revision;
        const recoveredSignature = composerDraftSignature(
          serverText,
          imageUrls,
          serverContextAttachments,
          preservedBlocksRef.current,
          draft?.replyTo,
        );
        // P1 R10: Capture current signature BEFORE projection, not after
        // Reading inputRef.current after setInput may see the projected value
        const currentSignature = composerDraftSignature(
          inputRef.current,
          imageUrlsRef.current,
          contextAttachmentsRef.current,
          preservedBlocksRef.current,
          replyToIdRef.current,
        );
        lastSavedSignatureRef.current = recoveredSignature;
        setInput((localText) => mergeHydratedDraft(serverText, localText));
        setContextAttachments((local) => mergeContextAttachments(serverContextAttachments, local));
        if (draft?.replyTo) {
          const store = useChatStore.getState();
          const parent = store.messages.find((message) => message.id === draft.replyTo);
          setReplyTo({
            id: draft.replyTo,
            content: parent?.content ?? '(原消息未加载)',
            senderCatId: parent?.catId ?? null,
            threadId,
          });
        }
        await restoreDraftImages(imageUrls, threadId, false);
        if (hydrationGenerationRef.current !== generation) return;
        hydratedRef.current = true;
        // Mark as pending recovery if server has unsent draft that differs from pre-projection state
        const hasServerContent =
          serverText.trim() || imageUrls.length > 0 || serverContextAttachments.length > 0 || draft?.replyTo;
        if (hasServerContent && recoveredSignature !== currentSignature && canonicalDraftRef.current) {
          pendingRecoveryRef.current = { snapshot: canonicalDraftRef.current, revision, source: 'hydration' };
        }
      })
      .catch(() => {
        // The local session mirror remains available; autosave stays fenced.
      });
    hydrationSettledRef.current = hydration;
    void hydration;
    return () => {
      if (hydrationGenerationRef.current === generation) hydrationGenerationRef.current += 1;
    };
  }, [imageUrlsRef, resetImageRecovery, restoreDraftImages, setContextAttachments, setInput, setReplyTo, threadId]);

  const restoreAdmissionFallback = useCallback(() => {
    const fallback = clearFallbackRef.current;
    if (!fallback) return;
    setInput((current) => mergeHydratedDraft(current, fallback.text));
    restoreFallbackImages(fallback.images, fallback.imageUrls);
    setContextAttachments((current) => mergeContextAttachments(current, fallback.contextAttachments));
    if (fallback.replyTo && !useChatStore.getState().replyToMessage) setReplyTo(fallback.replyTo);
  }, [restoreFallbackImages, setContextAttachments, setInput, setReplyTo]);

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
      void restoreDraftImages(currentImages, threadId ?? '', false);
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
    [restoreDraftImages, setContextAttachments, setInput, setReplyTo, threadId],
  );

  const captureCurrentDraft = useCallback(
    (): DurableDraftSnapshot => ({
      text: inputRef.current,
      imageUrls: [...imageUrlsRef.current],
      // A file-side edit can be queued before React commits it. A server ACK keeps its own revision boundary.
      contextAttachments:
        threadId && !queuedServerAckBlocks()
          ? composerAttachments(threadId, contextAttachmentsRef.current)
          : [...contextAttachmentsRef.current],
      preservedBlocks: [...preservedBlocksRef.current],
      replyTo: replyToIdRef.current,
    }),
    [imageUrlsRef, threadId],
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
      // Only clear pendingRecovery if this was an admission save that consumed it
      if (allowPendingAdmission) {
        pendingRecoveryRef.current = null;
      }
      clearFallbackRef.current = null;
      return true;
    },
    [reconcileConflict, restoreAdmissionFallback, threadId],
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
  }, [captureCurrentDraft, persistDraftSnapshot, threadId]);

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

  const { persistSettledDraft } = useComposerDraftAutosave({
    threadId,
    hydratedRef,
    hydrationGenerationRef,
    ownerIdRef,
    admissionsPendingRef,
    admissionEpoch,
    input,
    images,
    contextAttachments,
    captureCurrentDraft,
    persistDraftSnapshot,
    persistCurrentDraft,
  });

  useEffect(() => {
    if (!threadId) return;
    return registerDurableComposerDraftAdmissionFlusher({
      threadId,
      hydrationSettledRef,
      ownerIdRef,
      pendingAdmissionDraftRef,
      canonicalDraftRef,
      pendingRecoveryRef,
      admissionImagesReady,
      recoveredDraftAwaitingConfirmationRef,
      revisionRef,
      captureCurrentDraft,
      persistDraftSnapshot,
      enqueueSave: enqueueComposerDraftSave,
    });
  }, [admissionImagesReady, captureCurrentDraft, persistDraftSnapshot, threadId]);
  useComposerDraftObservation({ threadId, textareaRef, revisionRef, hydratedRef, admissionsPendingRef });

  const beginAdmission = useCallback(
    (snapshot: ComposerAdmissionSnapshot) => {
      const ownerId = ownerIdRef.current; // P1-2 R8: Use stable owner ID, not hydration generation
      const durableSnapshot = { ...snapshot, imageUrls: [...imageUrlsRef.current] };
      const admittedDraft = durableDraftForAdmission(
        durableSnapshot,
        durableSnapshot.imageUrls,
        preservedBlocksRef.current,
      );

      // Clear pending recovery from hydration (user already saw it), but keep conflict recovery
      if (hydratedRef.current && pendingRecoveryRef.current?.source === 'hydration') {
        pendingRecoveryRef.current = null;
      }

      const pendingAdmission: PendingComposerAdmissionDraft = {
        snapshot: admittedDraft,
        files: [...durableSnapshot.images],
        confirmsRecoveredDraft: recoveredDraftAwaitingConfirmationRef.current,
        generation: ownerId, // P1-2 R8: Store ownerId, not hydration generation
        threadId: threadId ?? null,
      };
      recoveredDraftAwaitingConfirmationRef.current = false;
      pendingAdmissionDraftRef.current = pendingAdmission;
      admissionsPendingRef.current += 1;
      return (accepted: boolean | undefined) => {
        // P1-2 R8: Check stable owner ID, not hydration generation
        if (ownerId !== ownerIdRef.current || pendingAdmission.threadId !== threadId) {
          return;
        }

        admissionsPendingRef.current = Math.max(0, admissionsPendingRef.current - 1);
        if (pendingAdmissionDraftRef.current === pendingAdmission) pendingAdmissionDraftRef.current = null;
        if (accepted === false) {
          // P1-4: Use reconciliation result bound to this admission, not global canonical
          if (pendingAdmission.reconciliationResult) {
            // Display merged snapshot bound to this specific admission
            const merged = pendingAdmission.reconciliationResult.merged;
            setInput((curr) => mergeHydratedDraft(curr, merged.text));
            setContextAttachments((curr) => mergeContextAttachments(curr, merged.contextAttachments));
            void restoreDraftImages(merged.imageUrls, threadId ?? '', false);
            // Preserve current reply if user set one during save, otherwise use merged
            if (!useChatStore.getState().replyToMessage && merged.replyTo) {
              const store = useChatStore.getState();
              const parent = store.messages.find((message) => message.id === merged.replyTo);
              setReplyTo({
                id: merged.replyTo,
                content: parent?.content ?? '(原消息未加载)',
                senderCatId: parent?.catId ?? null,
                threadId: threadId ?? '',
              });
            }
          } else {
            // Restore attempted snapshot and preserve new input
            setInput((curr) => mergeHydratedDraft(curr, durableSnapshot.text));
            restoreFallbackImages(durableSnapshot.images, durableSnapshot.imageUrls);
            setContextAttachments((curr) => mergeContextAttachments(curr, durableSnapshot.contextAttachments));
            if (durableSnapshot.replyTo && !useChatStore.getState().replyToMessage) {
              setReplyTo(durableSnapshot.replyTo);
            }
          }
        } else {
          clearFallbackRef.current = durableSnapshot;
          persistSettledDraft(hydrationGenerationRef.current); // P1-2 R8: Use current hydration generation
        }
        setAdmissionEpoch((current) => current + 1);
      };
    },
    [
      imageUrlsRef,
      persistSettledDraft,
      restoreDraftImages,
      restoreFallbackImages,
      setContextAttachments,
      setInput,
      setReplyTo,
      threadId,
    ],
  );

  const markOptimisticallyCleared = useCallback(() => {
    inputRef.current = '';
    imageUrlsRef.current = [];
    contextAttachmentsRef.current = [];
    replyToIdRef.current = undefined;
  }, [imageUrlsRef]);
  return {
    beginAdmission,
    discardUnrestoredImages,
    markOptimisticallyCleared,
    removeImage,
    retryUnrestoredImages,
    unrestoredImageCount,
  };
}
