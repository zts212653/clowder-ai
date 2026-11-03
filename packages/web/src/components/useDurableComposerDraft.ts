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
} from './durable-composer-draft-helpers';
import { mergeContextAttachments } from './durable-composer-draft-merge';
import { enqueueComposerDraftSave, waitForComposerDraftSaves } from './durable-composer-draft-save-queue';
import { useComposerDraftAutosave } from './use-composer-draft-autosave';
import { useComposerDraftObservation } from './use-composer-draft-observation';
import { type PendingComposerRecovery, useComposerDraftPersistence } from './use-composer-draft-persistence';
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
  const pendingRecoveryRef = useRef<PendingComposerRecovery | null>(null);
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

  const { persistDraftSnapshot, persistCurrentDraft } = useComposerDraftPersistence({
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
  });

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
      const hydrationGeneration = hydrationGenerationRef.current;
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
        generation: ownerId, // P1-2 R8: Store ownerId, not hydration generation
        threadId: threadId ?? null,
      };
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
            restoreFallbackImages(durableSnapshot.images, merged.imageUrls);
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
          persistSettledDraft(hydrationGeneration);
        }
        setAdmissionEpoch((current) => current + 1);
      };
    },
    [imageUrlsRef, persistSettledDraft, restoreFallbackImages, setContextAttachments, setInput, setReplyTo, threadId],
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
