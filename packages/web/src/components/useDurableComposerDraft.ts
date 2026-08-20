'use client';

import type { ContextAttachment, MessageContent } from '@cat-cafe/shared';
import { type Dispatch, type RefObject, type SetStateAction, useCallback, useEffect, useRef, useState } from 'react';
import { useChatStore } from '@/stores/chatStore';
import { loadOwnerComposerDraft } from '@/utils/true-recall';
import { registerComposerDraftFlusher } from './composer-draft-flush-registry';
import {
  composerDraftSignature,
  contextAttachmentsFromDraft,
  type DurableDraftSnapshot,
  imageUrlsFromDraft,
  mergeHydratedDraft,
  preservedBlocksFromDraft,
  writeOwnerComposerDraft,
} from './durable-composer-draft-helpers';
import { mergeContextAttachments } from './durable-composer-draft-merge';
import { removeDraftImage, useDraftImageRestoration } from './use-durable-composer-draft-images';
import { usePendingComposerDraftInsert } from './use-pending-composer-draft-insert';
import { usePendingComposerSelection } from './use-pending-composer-selection';

interface ReplyDraft {
  id: string;
  content: string;
  senderCatId: string | null;
  threadId: string;
}

interface AdmissionSnapshot {
  text: string;
  images: File[];
  contextAttachments: ContextAttachment[];
  replyTo: ReplyDraft | null;
}

type ComposerDraftSave = () => Promise<boolean>;

const composerDraftSaveTails = new Map<string, Promise<boolean>>();

function enqueueComposerDraftSave(threadId: string, save: ComposerDraftSave): Promise<boolean> {
  const previous = composerDraftSaveTails.get(threadId) ?? Promise.resolve(true);
  const next = previous.catch(() => false).then(save);
  composerDraftSaveTails.set(threadId, next);
  void next.then(
    () => {
      if (composerDraftSaveTails.get(threadId) === next) composerDraftSaveTails.delete(threadId);
    },
    () => {
      if (composerDraftSaveTails.get(threadId) === next) composerDraftSaveTails.delete(threadId);
    },
  );
  return next;
}

async function waitForComposerDraftSaves(threadId: string): Promise<void> {
  await composerDraftSaveTails.get(threadId)?.catch(() => false);
}

interface UseDurableComposerDraftOptions {
  threadId?: string;
  input: string;
  setInput: Dispatch<SetStateAction<string>>;
  images: File[];
  setImages: Dispatch<SetStateAction<File[]>>;
  contextAttachments: ContextAttachment[];
  setContextAttachments: Dispatch<SetStateAction<ContextAttachment[]>>;
  replyToMessage: ReplyDraft | null;
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
  const lastSavedSignatureRef = useRef('');
  const hydrationGenerationRef = useRef(0);
  const imageUrlsRef = useRef<string[]>([]);
  const contextAttachmentsRef = useRef<ContextAttachment[]>(contextAttachments);
  const preservedBlocksRef = useRef<MessageContent[]>([]);
  const replyToIdRef = useRef(replyToMessage?.id);
  const admissionsPendingRef = useRef(0);
  const clearFallbackRef = useRef<(AdmissionSnapshot & { imageUrls: string[] }) | null>(null);
  const pendingSelectionRef = useRef<{ text: string; start: number; end: number } | null>(null);
  const [admissionEpoch, setAdmissionEpoch] = useState(0);

  const restoreDraftImages = useDraftImageRestoration({
    threadId,
    imageUrlsRef,
    setImages,
    setIsPreparingImages,
  });

  usePendingComposerDraftInsert({
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
  });

  usePendingComposerSelection(input, textareaRef, pendingSelectionRef, contextAttachments.length);

  useEffect(() => {
    inputRef.current = input;
  }, [input]);

  useEffect(() => {
    contextAttachmentsRef.current = contextAttachments;
  }, [contextAttachments]);

  useEffect(() => {
    replyToIdRef.current = replyToMessage?.id;
  }, [replyToMessage?.id]);

  useEffect(() => {
    if (!threadId) return;
    const generation = ++hydrationGenerationRef.current;
    hydratedRef.current = false;
    void waitForComposerDraftSaves(threadId)
      .then(() => loadOwnerComposerDraft(threadId))
      .then(({ draft, revision }) => {
        if (hydrationGenerationRef.current !== generation) return;
        const serverText = draft?.text ?? '';
        const imageUrls = imageUrlsFromDraft(draft);
        const serverContextAttachments = contextAttachmentsFromDraft(draft);
        preservedBlocksRef.current = preservedBlocksFromDraft(draft);
        revisionRef.current = revision;
        imageUrlsRef.current = imageUrls;
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
        void restoreDraftImages(imageUrls, threadId, false);
        hydratedRef.current = true;
      })
      .catch(() => {
        // The local session mirror remains available; autosave stays fenced.
      });
    return () => {
      if (hydrationGenerationRef.current === generation) hydrationGenerationRef.current += 1;
    };
  }, [restoreDraftImages, setContextAttachments, setInput, setReplyTo, threadId]);

  const restoreAdmissionFallback = useCallback(() => {
    const fallback = clearFallbackRef.current;
    if (!fallback) return;
    setInput((current) => mergeHydratedDraft(fallback.text, current));
    setImages((current) => [...new Set([...fallback.images, ...current])].slice(0, 5));
    setContextAttachments((current) => mergeContextAttachments(fallback.contextAttachments, current));
    imageUrlsRef.current = [...new Set([...fallback.imageUrls, ...imageUrlsRef.current])].slice(0, 5);
    if (fallback.replyTo && !useChatStore.getState().replyToMessage) setReplyTo(fallback.replyTo);
  }, [setContextAttachments, setImages, setInput, setReplyTo]);

  const reconcileConflict = useCallback(
    (draft: Awaited<ReturnType<typeof loadOwnerComposerDraft>>, shouldClear: boolean) => {
      revisionRef.current = draft.revision;
      const currentImages = imageUrlsFromDraft(draft.draft);
      const currentContextAttachments = contextAttachmentsFromDraft(draft.draft);
      preservedBlocksRef.current = preservedBlocksFromDraft(draft.draft);
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
      contextAttachments: [...contextAttachmentsRef.current],
      preservedBlocks: [...preservedBlocksRef.current],
      replyTo: replyToIdRef.current,
    }),
    [],
  );

  const persistDraftSnapshot = useCallback(
    async (snapshot: DurableDraftSnapshot) => {
      if (!threadId || admissionsPendingRef.current > 0) return false;
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
      clearFallbackRef.current = null;
      return true;
    },
    [reconcileConflict, restoreAdmissionFallback, threadId],
  );

  const persistCurrentDraft = useCallback(
    () => persistDraftSnapshot(captureCurrentDraft()),
    [captureCurrentDraft, persistDraftSnapshot],
  );

  useEffect(() => {
    if (!threadId) return;
    return () => {
      if (!hydratedRef.current || admissionsPendingRef.current > 0) return;
      const snapshot = captureCurrentDraft();
      void enqueueComposerDraftSave(threadId, () => persistDraftSnapshot(snapshot));
    };
  }, [captureCurrentDraft, persistDraftSnapshot, threadId]);

  useEffect(() => {
    if (!threadId || !hydratedRef.current || admissionsPendingRef.current > 0) return;
    void admissionEpoch;
    void images;
    void contextAttachments;
    void input;
    const timer = window.setTimeout(() => {
      void enqueueComposerDraftSave(threadId, persistCurrentDraft);
    }, 400);
    return () => window.clearTimeout(timer);
  }, [admissionEpoch, contextAttachments, images, input, persistCurrentDraft, threadId]);

  useEffect(() => {
    if (!threadId) return;
    return registerComposerDraftFlusher(threadId, async () => {
      const snapshot = captureCurrentDraft();
      const persisted = await enqueueComposerDraftSave(threadId, () => persistDraftSnapshot(snapshot));
      return {
        persisted,
        snapshot: {
          text: snapshot.text,
          contextAttachments: snapshot.contextAttachments,
          ...(snapshot.replyTo ? { replyToId: snapshot.replyTo } : {}),
        },
      };
    });
  }, [captureCurrentDraft, persistDraftSnapshot, threadId]);

  const beginAdmission = useCallback(
    (snapshot: AdmissionSnapshot) => {
      const durableSnapshot = { ...snapshot, imageUrls: [...imageUrlsRef.current] };
      admissionsPendingRef.current += 1;
      return (accepted: boolean | undefined) => {
        admissionsPendingRef.current = Math.max(0, admissionsPendingRef.current - 1);
        if (accepted === false) {
          setInput((current) => mergeHydratedDraft(durableSnapshot.text, current));
          setImages((current) => [...new Set([...durableSnapshot.images, ...current])].slice(0, 5));
          setContextAttachments((current) => mergeContextAttachments(durableSnapshot.contextAttachments, current));
          imageUrlsRef.current = [...new Set([...durableSnapshot.imageUrls, ...imageUrlsRef.current])].slice(0, 5);
          if (durableSnapshot.replyTo && !useChatStore.getState().replyToMessage) {
            setReplyTo(durableSnapshot.replyTo);
          }
        } else {
          clearFallbackRef.current = durableSnapshot;
        }
        setAdmissionEpoch((current) => current + 1);
      };
    },
    [setContextAttachments, setImages, setInput, setReplyTo],
  );

  const markOptimisticallyCleared = useCallback(() => {
    inputRef.current = '';
    imageUrlsRef.current = [];
  }, []);

  const removeImage = useCallback((index: number) => removeDraftImage(index, imageUrlsRef, setImages), [setImages]);

  return { beginAdmission, markOptimisticallyCleared, removeImage };
}
