'use client';

import { type Dispatch, type MutableRefObject, type SetStateAction, useCallback } from 'react';
import { useChatStore } from '@/stores/chatStore';
import { downloadDraftImages, getRecoveredDraftImageUrl } from './durable-composer-draft-helpers';
import { hasPendingThreadDraft, threadImageDrafts } from './thread-drafts';

interface DraftImageRestorationOptions {
  threadId?: string;
  imageUrlsRef: MutableRefObject<string[]>;
  setImages: Dispatch<SetStateAction<File[]>>;
  setIsPreparingImages: Dispatch<SetStateAction<boolean>>;
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
    async (urls: readonly string[], targetThreadId: string, authoritative: boolean) => {
      const uniqueUrls = [...new Set(urls)];
      imageUrlsRef.current = authoritative ? uniqueUrls : [...new Set([...imageUrlsRef.current, ...uniqueUrls])];
      if (uniqueUrls.length === 0) {
        restoreEmptyDraftImages(authoritative, targetThreadId, setImages);
        return;
      }
      setIsPreparingImages(true);
      try {
        const restored = await downloadDraftImages(uniqueUrls);
        const existing = priorDraftImages(authoritative, targetThreadId);
        const merged = mergeDraftImages(existing, restored);
        if (merged.length > 0) threadImageDrafts.set(targetThreadId, merged);
        else threadImageDrafts.delete(targetThreadId);
        setThreadHasDraft(targetThreadId, merged.length > 0 || hasPendingThreadDraft(targetThreadId));
        if (targetThreadId === threadId) setImages(merged);
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
): void {
  setImages((current) => {
    const removedUrl = getRecoveredDraftImageUrl(current[index]);
    if (removedUrl) imageUrlsRef.current = imageUrlsRef.current.filter((url) => url !== removedUrl);
    return current.filter((_, itemIndex) => itemIndex !== index);
  });
}
