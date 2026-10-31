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
  const contextAttachmentsRef = useRef<ContextAttachment[]>(contextAttachments);
  const preservedBlocksRef = useRef<MessageContent[]>([]);
  const replyToIdRef = useRef(replyToMessage?.id);
  const admissionsPendingRef = useRef(0);
  const pendingAdmissionDraftRef = useRef<PendingComposerAdmissionDraft | null>(null);
  const canonicalDraftRef = useRef<DurableDraftSnapshot | null>(null);
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
    hydratedRef.current = false;
    canonicalDraftRef.current = null;
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
        lastSavedSignatureRef.current = composerDraftSignature(
          serverText,
          imageUrls,
          serverContextAttachments,
          preservedBlocksRef.current,
          draft?.replyTo,
        );
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
      })
      .catch(() => {
        // The local session mirror remains available; autosave stays fenced.
      });
    hydrationSettledRef.current = hydration;
    void hydration;
    return () => {
      if (hydrationGenerationRef.current === generation) hydrationGenerationRef.current += 1;
    };
  }, [resetImageRecovery, restoreDraftImages, setContextAttachments, setInput, setReplyTo, threadId]);

  const restoreAdmissionFallback = useCallback(() => {
    const fallback = clearFallbackRef.current;
    if (!fallback) return;
    setInput((current) => mergeHydratedDraft(current, fallback.text));
    restoreFallbackImages(fallback.images, fallback.imageUrls);
    setContextAttachments((current) => mergeContextAttachments(current, fallback.contextAttachments));
    if (fallback.replyTo && !useChatStore.getState().replyToMessage) setReplyTo(fallback.replyTo);
  }, [restoreFallbackImages, setContextAttachments, setInput, setReplyTo]);

  const reconcileConflict = useCallback(
    (draft: Awaited<ReturnType<typeof loadOwnerComposerDraft>>, shouldClear: boolean) => {
      revisionRef.current = draft.revision;
      const currentImages = imageUrlsFromDraft(draft.draft);
      const currentContextAttachments = contextAttachmentsFromDraft(draft.draft);
      preservedBlocksRef.current = preservedBlocksFromDraft(draft.draft);
      canonicalDraftRef.current = durableDraftSnapshotFromOwner(draft.draft);
      lastSavedSignatureRef.current = composerDraftSignature(
        draft.draft?.text ?? '',
        currentImages,
        currentContextAttachments,
        preservedBlocksRef.current,
        draft.draft?.replyTo,
      );
      if (!shouldClear) return;
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
    async (snapshot: DurableDraftSnapshot, allowPendingAdmission = false) => {
      if (!threadId || (admissionsPendingRef.current > 0 && !allowPendingAdmission)) return false;
      const signature = composerDraftSignature(
        snapshot.text,
        snapshot.imageUrls,
        snapshot.contextAttachments,
        snapshot.preservedBlocks,
        snapshot.replyTo,
      );
      if (signature === lastSavedSignatureRef.current) return true;
      const shouldClear =
        !snapshot.text.trim() &&
        snapshot.imageUrls.length === 0 &&
        snapshot.contextAttachments.length === 0 &&
        snapshot.preservedBlocks.length === 0 &&
        !snapshot.replyTo;
      const result = await writeOwnerComposerDraft(threadId, revisionRef.current, snapshot);
      if (result.kind === 'conflict') {
        reconcileConflict(result, shouldClear);
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
    [reconcileConflict, restoreAdmissionFallback, threadId],
  );

  const persistCurrentDraft = useCallback(
    () => persistDraftSnapshot(captureCurrentDraft()),
    [captureCurrentDraft, persistDraftSnapshot],
  );
  saveCurrentDraftForImagesRef.current = threadId
    ? () => enqueueComposerDraftSave(threadId, persistCurrentDraft)
    : async () => false;
  const { persistSettledDraft } = useComposerDraftAutosave({
    threadId,
    hydratedRef,
    hydrationGenerationRef,
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
      pendingAdmissionDraftRef,
      canonicalDraftRef,
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
      const generation = hydrationGenerationRef.current;
      const durableSnapshot = { ...snapshot, imageUrls: [...imageUrlsRef.current] };
      const admittedDraft = durableDraftForAdmission(
        durableSnapshot,
        durableSnapshot.imageUrls,
        preservedBlocksRef.current,
      );
      const pendingAdmission = {
        snapshot: admittedDraft,
        files: [...durableSnapshot.images],
        confirmsRecoveredDraft: recoveredDraftAwaitingConfirmationRef.current,
      };
      recoveredDraftAwaitingConfirmationRef.current = false;
      pendingAdmissionDraftRef.current = pendingAdmission;
      admissionsPendingRef.current += 1;
      return (accepted: boolean | undefined) => {
        admissionsPendingRef.current = Math.max(0, admissionsPendingRef.current - 1);
        if (pendingAdmissionDraftRef.current === pendingAdmission) pendingAdmissionDraftRef.current = null;
        if (accepted === false) {
          setInput((current) => mergeHydratedDraft(current, durableSnapshot.text));
          restoreFallbackImages(durableSnapshot.images, durableSnapshot.imageUrls);
          setContextAttachments((current) => mergeContextAttachments(current, durableSnapshot.contextAttachments));
          if (durableSnapshot.replyTo && !useChatStore.getState().replyToMessage) {
            setReplyTo(durableSnapshot.replyTo);
          }
        } else {
          clearFallbackRef.current = durableSnapshot;
          persistSettledDraft(generation);
        }
        setAdmissionEpoch((current) => current + 1);
      };
    },
    [imageUrlsRef, persistSettledDraft, restoreFallbackImages, setContextAttachments, setInput, setReplyTo],
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
