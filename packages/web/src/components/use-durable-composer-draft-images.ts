'use client';

import { type Dispatch, type MutableRefObject, type SetStateAction, useCallback, useRef, useState } from 'react';
import { useChatStore } from '@/stores/chatStore';
import { downloadDraftImages, getRecoveredDraftImageUrl } from './durable-composer-draft-helpers';
import { hasPendingThreadDraft, threadImageDrafts } from './thread-drafts';

interface DraftImageRestorationOptions {
  threadId?: string;
  imageUrlsRef: MutableRefObject<string[]>;
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
  imageUrlsRef,
  setImages,
  setIsPreparingImages,
}: DraftImageRestorationOptions) {
  const setThreadHasDraft = useChatStore((state) => state.setThreadHasDraft);
  return useCallback(
    async (
      urls: readonly string[],
      targetThreadId: string,
      authoritative: boolean,
    ): Promise<DraftImageRestorationResult> => {
      const uniqueUrls = [...new Set(urls)];
      imageUrlsRef.current = authoritative ? uniqueUrls : [...new Set([...imageUrlsRef.current, ...uniqueUrls])];
      if (uniqueUrls.length === 0) {
        restoreEmptyDraftImages(authoritative, targetThreadId, setImages);
        return draftImageCoverage(imageUrlsRef.current, threadImageDrafts.get(targetThreadId) ?? []);
      }
      setIsPreparingImages(true);
      try {
        const restored = await downloadDraftImages(uniqueUrls);
        const currentUrls = new Set(imageUrlsRef.current);
        const existing = priorDraftImages(authoritative, targetThreadId);
        const merged = mergeDraftImages(
          existing,
          restored.filter((file) => currentUrls.has(getRecoveredDraftImageUrl(file) ?? '')),
        );
        if (merged.length > 0) threadImageDrafts.set(targetThreadId, merged);
        else threadImageDrafts.delete(targetThreadId);
        setThreadHasDraft(targetThreadId, merged.length > 0 || hasPendingThreadDraft(targetThreadId));
        if (targetThreadId === threadId) setImages(merged);
        return draftImageCoverage(imageUrlsRef.current, merged);
      } finally {
        setIsPreparingImages(false);
      }
    },
    [imageUrlsRef, setImages, setIsPreparingImages, setThreadHasDraft, threadId],
  );
}

export function removeDraftImage(
  index: number,
  imageUrlsRef: MutableRefObject<string[]>,
  setImages: Dispatch<SetStateAction<File[]>>,
  onChange?: (files: File[]) => void,
): void {
  setImages((current) => {
    const removedUrl = getRecoveredDraftImageUrl(current[index]);
    if (removedUrl) imageUrlsRef.current = imageUrlsRef.current.filter((url) => url !== removedUrl);
    const next = current.filter((_, itemIndex) => itemIndex !== index);
    onChange?.(next);
    return next;
  });
}

interface SaveCurrentDraftRef {
  current: () => Promise<boolean>;
}

interface DurableComposerDraftImageStateOptions {
  threadId?: string;
  setImages: Dispatch<SetStateAction<File[]>>;
  setIsPreparingImages: Dispatch<SetStateAction<boolean>>;
  saveCurrentDraftRef: SaveCurrentDraftRef;
}

export function useDurableComposerDraftImageState({
  threadId,
  setImages,
  setIsPreparingImages,
  saveCurrentDraftRef,
}: DurableComposerDraftImageStateOptions) {
  const imageUrlsRef = useRef<string[]>([]);
  const unresolvedImageUrlsRef = useRef<string[]>([]);
  const [unrestoredImageCount, setUnrestoredImageCount] = useState(0);
  const restoreImages = useDraftImageRestoration({ threadId, imageUrlsRef, setImages, setIsPreparingImages });

  const applyRestoration = useCallback((result: DraftImageRestorationResult) => {
    unresolvedImageUrlsRef.current = result.unresolvedUrls;
    setUnrestoredImageCount(result.unresolvedUrls.length);
  }, []);
  const applyCoverage = useCallback(
    (files: readonly File[]) => applyRestoration(draftImageCoverage(imageUrlsRef.current, files)),
    [applyRestoration],
  );
  const resetImageRecovery = useCallback(() => {
    imageUrlsRef.current = [];
    applyRestoration({ complete: true, unresolvedUrls: [] });
  }, [applyRestoration]);
  const restoreDraftImages = useCallback(
    async (urls: readonly string[], targetThreadId: string, authoritative: boolean) => {
      const result = await restoreImages(urls, targetThreadId, authoritative);
      applyRestoration(result);
      return result;
    },
    [applyRestoration, restoreImages],
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
    const priorUrls = imageUrlsRef.current;
    const discarded = new Set(unresolvedImageUrlsRef.current);
    imageUrlsRef.current = priorUrls.filter((url) => !discarded.has(url));
    applyCoverage(threadImageDrafts.get(threadId) ?? []);
    setIsPreparingImages(true);
    let persisted = false;
    try {
      persisted = await saveCurrentDraftRef.current();
    } catch {
      persisted = false;
    }
    if (!persisted) {
      imageUrlsRef.current = priorUrls;
      applyCoverage(threadImageDrafts.get(threadId) ?? []);
    }
    setIsPreparingImages(false);
  }, [applyCoverage, saveCurrentDraftRef, setIsPreparingImages, threadId]);
  const removeImage = useCallback(
    (index: number) => removeDraftImage(index, imageUrlsRef, setImages, applyCoverage),
    [applyCoverage, setImages],
  );
  const admissionImagesReady = useCallback(
    (pendingFiles: readonly File[], requiredUrls: readonly string[]) => {
      const current = threadId ? (threadImageDrafts.get(threadId) ?? []) : [];
      return draftImageCoverage(requiredUrls, mergeDraftImages(pendingFiles, current)).complete;
    },
    [threadId],
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
