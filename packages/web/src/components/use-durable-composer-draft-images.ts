'use client';

import type { MessageContent } from '@cat-cafe/shared';
import { type Dispatch, type MutableRefObject, type SetStateAction, useCallback, useRef, useState } from 'react';
import { useChatStore } from '@/stores/chatStore';
import { apiSessionIdentity } from '@/utils/api-session-identity';
import {
  downloadDraftAttachments,
  draftAttachmentUrls,
  getRecoveredDraftImageUrl,
} from './durable-composer-draft-helpers';
import { hasPendingThreadDraft, threadImageDrafts } from './thread-drafts';

interface DraftImageRestorationOptions {
  threadId?: string;
  ownerIdRef: MutableRefObject<number>;
  imageUrlsRef: MutableRefObject<string[]>;
  preservedBlocksRef: MutableRefObject<MessageContent[]>;
  setImages: Dispatch<SetStateAction<File[]>>;
  setIsPreparingImages: Dispatch<SetStateAction<boolean>>;
}

export interface DraftImageRestorationResult {
  complete: boolean;
  unresolvedUrls: string[];
}

function priorDraftImages(authoritative: boolean, threadId: string): File[] {
  const prior = threadImageDrafts.get(threadId) ?? [];
  return authoritative ? prior.filter((file) => !getRecoveredDraftImageUrl(file)) : prior;
}

function mergeDraftImages(existing: readonly File[], restored: readonly File[]): File[] {
  const seenFiles = new Set<File>();
  const seenRecoveredUrls = new Set<string>();
  const merged: File[] = [];
  for (const file of [...existing, ...restored]) {
    if (seenFiles.has(file)) continue;
    const recoveredUrl = getRecoveredDraftImageUrl(file);
    if (recoveredUrl && seenRecoveredUrls.has(recoveredUrl)) continue;
    seenFiles.add(file);
    if (recoveredUrl) seenRecoveredUrls.add(recoveredUrl);
    merged.push(file);
    if (merged.length === 5) break;
  }
  return merged;
}

export function draftImageCoverage(
  canonicalUrls: readonly string[],
  files: readonly File[],
): DraftImageRestorationResult {
  const representedUrls = new Set(files.flatMap((file) => getRecoveredDraftImageUrl(file) ?? []));
  const unresolvedUrls = [...new Set(canonicalUrls)].filter((url) => !representedUrls.has(url));
  return { complete: unresolvedUrls.length === 0, unresolvedUrls };
}

function restoreEmptyDraftImages(
  authoritative: boolean,
  targetThreadId: string,
  setImages: Dispatch<SetStateAction<File[]>>,
): void {
  if (!authoritative) return;
  const localOnly = priorDraftImages(true, targetThreadId);
  if (localOnly.length > 0) threadImageDrafts.set(targetThreadId, localOnly);
  else threadImageDrafts.delete(targetThreadId);
  setImages(localOnly);
}

export function useDraftImageRestoration({
  threadId,
  ownerIdRef,
  imageUrlsRef,
  preservedBlocksRef,
  setImages,
  setIsPreparingImages,
}: DraftImageRestorationOptions) {
  const currentThreadRef = useRef(threadId);
  currentThreadRef.current = threadId;
  const setThreadHasDraft = useChatStore((state) => state.setThreadHasDraft);
  return useCallback(
    async (
      urls: readonly string[],
      targetThreadId: string,
      authoritative: boolean,
    ): Promise<DraftImageRestorationResult> => {
      const uniqueImageUrls = [...new Set(urls)];
      const blocks = preservedBlocksRef.current;
      const uniqueUrls = draftAttachmentUrls(uniqueImageUrls, blocks);
      const ownerId = ownerIdRef.current;
      const ownerUserId = apiSessionIdentity.getSnapshot().ownerUserId;
      const stillOwned = () =>
        ownerIdRef.current === ownerId &&
        currentThreadRef.current === targetThreadId &&
        apiSessionIdentity.getSnapshot().ownerUserId === ownerUserId;
      if (!stillOwned()) return { complete: false, unresolvedUrls: uniqueUrls };
      imageUrlsRef.current = authoritative
        ? uniqueImageUrls
        : [...new Set([...imageUrlsRef.current, ...uniqueImageUrls])];
      if (uniqueUrls.length === 0) {
        restoreEmptyDraftImages(authoritative, targetThreadId, setImages);
        return draftImageCoverage(
          draftAttachmentUrls(imageUrlsRef.current, preservedBlocksRef.current),
          threadImageDrafts.get(targetThreadId) ?? [],
        );
      }
      setIsPreparingImages(true);
      try {
        const restored = await downloadDraftAttachments(uniqueUrls, blocks);
        if (!stillOwned()) return { complete: false, unresolvedUrls: uniqueUrls };
        const requiredUrls = draftAttachmentUrls(imageUrlsRef.current, preservedBlocksRef.current);
        const currentUrls = new Set(requiredUrls);
        const existing = priorDraftImages(authoritative, targetThreadId);
        const merged = mergeDraftImages(
          existing,
          restored.filter((file) => currentUrls.has(getRecoveredDraftImageUrl(file) ?? '')),
        );
        if (merged.length > 0) threadImageDrafts.set(targetThreadId, merged);
        else threadImageDrafts.delete(targetThreadId);
        setThreadHasDraft(targetThreadId, merged.length > 0 || hasPendingThreadDraft(targetThreadId));
        if (targetThreadId === threadId) setImages(merged);
        return draftImageCoverage(requiredUrls, merged);
      } finally {
        if (stillOwned()) setIsPreparingImages(false);
      }
    },
    [imageUrlsRef, ownerIdRef, preservedBlocksRef, setImages, setIsPreparingImages, setThreadHasDraft, threadId],
  );
}

export function removeDraftImage(
  index: number,
  imageUrlsRef: MutableRefObject<string[]>,
  setImages: Dispatch<SetStateAction<File[]>>,
  onChange?: (files: File[], removedUrl: string | undefined) => void,
): void {
  setImages((current) => {
    const removedUrl = getRecoveredDraftImageUrl(current[index]);
    if (removedUrl) imageUrlsRef.current = imageUrlsRef.current.filter((url) => url !== removedUrl);
    const next = current.filter((_, itemIndex) => itemIndex !== index);
    onChange?.(next, removedUrl);
    return next;
  });
}

interface SaveCurrentDraftRef {
  current: () => Promise<boolean>;
}

interface DurableComposerDraftImageStateOptions {
  threadId?: string;
  ownerIdRef: MutableRefObject<number>;
  preservedBlocksRef: MutableRefObject<MessageContent[]>;
  setImages: Dispatch<SetStateAction<File[]>>;
  setIsPreparingImages: Dispatch<SetStateAction<boolean>>;
  saveCurrentDraftRef: SaveCurrentDraftRef;
}

export function useDurableComposerDraftImageState({
  threadId,
  ownerIdRef,
  preservedBlocksRef,
  setImages,
  setIsPreparingImages,
  saveCurrentDraftRef,
}: DurableComposerDraftImageStateOptions) {
  const imageUrlsRef = useRef<string[]>([]);
  const unresolvedImageUrlsRef = useRef<string[]>([]);
  const [unrestoredImageCount, setUnrestoredImageCount] = useState(0);
  const restoreImages = useDraftImageRestoration({
    threadId,
    ownerIdRef,
    imageUrlsRef,
    preservedBlocksRef,
    setImages,
    setIsPreparingImages,
  });

  const applyRestoration = useCallback((result: DraftImageRestorationResult) => {
    unresolvedImageUrlsRef.current = result.unresolvedUrls;
    setUnrestoredImageCount(result.unresolvedUrls.length);
  }, []);
  const applyCoverage = useCallback(
    (files: readonly File[]) =>
      applyRestoration(
        draftImageCoverage(draftAttachmentUrls(imageUrlsRef.current, preservedBlocksRef.current), files),
      ),
    [applyRestoration, preservedBlocksRef],
  );
  const resetImageRecovery = useCallback(() => {
    imageUrlsRef.current = [];
    applyRestoration({ complete: true, unresolvedUrls: [] });
    setIsPreparingImages(false);
  }, [applyRestoration, setIsPreparingImages]);
  const restoreDraftImages = useCallback(
    async (urls: readonly string[], targetThreadId: string, authoritative: boolean) => {
      const ownerId = ownerIdRef.current;
      const ownerUserId = apiSessionIdentity.getSnapshot().ownerUserId;
      const result = await restoreImages(urls, targetThreadId, authoritative);
      if (ownerId !== ownerIdRef.current || apiSessionIdentity.getSnapshot().ownerUserId !== ownerUserId)
        return { complete: false, unresolvedUrls: [...urls] };
      applyRestoration(result);
      return result;
    },
    [applyRestoration, ownerIdRef, restoreImages],
  );
  const restoreFallbackImages = useCallback(
    (fallbackFiles: readonly File[], fallbackUrls: readonly string[]) => {
      imageUrlsRef.current = [...new Set([...fallbackUrls, ...imageUrlsRef.current])];
      setImages((current) => {
        const merged = mergeDraftImages(fallbackFiles, current);
        applyCoverage(merged);
        return merged;
      });
    },
    [applyCoverage, setImages],
  );
  const retryUnrestoredImages = useCallback(async () => {
    if (!threadId) return;
    await restoreDraftImages(imageUrlsRef.current, threadId, false);
  }, [restoreDraftImages, threadId]);
  const discardUnrestoredImages = useCallback(async () => {
    if (!threadId || unresolvedImageUrlsRef.current.length === 0) return;
    // P1 R9: Capture owner before async save
    const ownerId = ownerIdRef.current;
    const ownerUserId = apiSessionIdentity.getSnapshot().ownerUserId;
    const capturedThreadId = threadId;
    const stillOwned = () =>
      ownerId === ownerIdRef.current &&
      capturedThreadId === threadId &&
      apiSessionIdentity.getSnapshot().ownerUserId === ownerUserId;
    const priorUrls = imageUrlsRef.current;
    const priorBlocks = preservedBlocksRef.current;
    const discarded = new Set(unresolvedImageUrlsRef.current);
    imageUrlsRef.current = priorUrls.filter((url) => !discarded.has(url));
    preservedBlocksRef.current = priorBlocks.filter((block) => block.type !== 'file' || !discarded.has(block.url));
    applyCoverage(threadImageDrafts.get(threadId) ?? []);
    setIsPreparingImages(true);
    let persisted = false;
    try {
      persisted = await saveCurrentDraftRef.current();
    } catch {
      persisted = false;
    }
    // P1 R9: Validate owner after async save - rollback only if still same owner
    if (!persisted) {
      if (stillOwned()) {
        imageUrlsRef.current = priorUrls;
        preservedBlocksRef.current = priorBlocks;
        applyCoverage(threadImageDrafts.get(threadId) ?? []);
      }
      // If owner changed, old rollback must not pollute new owner state
    }
    // P1 R9: Only clear preparing if still same owner
    if (stillOwned()) {
      setIsPreparingImages(false);
    }
  }, [applyCoverage, ownerIdRef, preservedBlocksRef, saveCurrentDraftRef, setIsPreparingImages, threadId]);
  const removeImage = useCallback(
    (index: number) =>
      removeDraftImage(index, imageUrlsRef, setImages, (files, removedUrl) => {
        preservedBlocksRef.current = preservedBlocksRef.current.filter(
          (block) => block.type !== 'file' || block.url !== removedUrl,
        );
        applyCoverage(files);
      }),
    [applyCoverage, preservedBlocksRef, setImages],
  );
  const admissionImagesReady = useCallback(
    (pendingFiles: readonly File[], requiredUrls: readonly string[]) => {
      const current = threadId ? (threadImageDrafts.get(threadId) ?? []) : [];
      return draftImageCoverage(
        draftAttachmentUrls(requiredUrls, preservedBlocksRef.current),
        mergeDraftImages(pendingFiles, current),
      ).complete;
    },
    [preservedBlocksRef, threadId],
  );

  return {
    admissionImagesReady,
    applyRestoration,
    discardUnrestoredImages,
    imageUrlsRef,
    removeImage,
    resetImageRecovery,
    restoreDraftImages,
    restoreFallbackImages,
    retryUnrestoredImages,
    unrestoredImageCount,
  };
}
