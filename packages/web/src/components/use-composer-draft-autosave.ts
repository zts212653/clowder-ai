'use client';

import type { ContextAttachment } from '@cat-cafe/shared';
import { type MutableRefObject, useCallback, useEffect } from 'react';
import type { DurableDraftSnapshot } from './durable-composer-draft-helpers';
import { enqueueComposerDraftSave } from './durable-composer-draft-save-queue';

interface DraftAutosaveOptions {
  threadId?: string;
  hydratedRef: MutableRefObject<boolean>;
  hydrationGenerationRef: MutableRefObject<number>;
  ownerIdRef: MutableRefObject<number>;
  admissionsPendingRef: MutableRefObject<number>;
  admissionEpoch: number;
  input: string;
  images: File[];
  contextAttachments: ContextAttachment[];
  captureCurrentDraft: () => DurableDraftSnapshot;
  persistDraftSnapshot: (
    snapshot: DurableDraftSnapshot,
    allowPendingAdmission?: boolean,
    boundOwnerId?: number,
    boundThreadId?: string | null,
  ) => Promise<boolean>;
  persistCurrentDraft: () => Promise<boolean>;
}

/** Editing keeps its debounce; page exit and accepted sends flush through the same revisioned owner queue. */
export function useComposerDraftAutosave(options: DraftAutosaveOptions) {
  const {
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
  } = options;
  useEffect(() => {
    if (!threadId) return;
    const flush = () => {
      if (!hydratedRef.current || admissionsPendingRef.current > 0) return;
      // P1 R7: Capture owner identity (not revision), let revision advance in queue
      const ownerId = ownerIdRef.current;
      const capturedThreadId = threadId;
      const snapshot = captureCurrentDraft();
      void enqueueComposerDraftSave(threadId, () => persistDraftSnapshot(snapshot, false, ownerId, capturedThreadId));
    };
    window.addEventListener('pagehide', flush);
    return () => {
      window.removeEventListener('pagehide', flush);
      flush();
    };
  }, [admissionsPendingRef, captureCurrentDraft, hydratedRef, ownerIdRef, persistDraftSnapshot, threadId]);

  useEffect(() => {
    if (!threadId || !hydratedRef.current || admissionsPendingRef.current > 0) return;
    void admissionEpoch;
    void images;
    void contextAttachments;
    void input;
    const timer = window.setTimeout(() => {
      // P1 R7: Capture owner identity, let revision advance in queue
      const ownerId = ownerIdRef.current;
      const capturedThreadId = threadId;
      const snapshot = captureCurrentDraft();
      void enqueueComposerDraftSave(threadId, () => persistDraftSnapshot(snapshot, false, ownerId, capturedThreadId));
    }, 400);
    return () => window.clearTimeout(timer);
  }, [
    admissionEpoch,
    admissionsPendingRef,
    captureCurrentDraft,
    contextAttachments,
    hydratedRef,
    images,
    input,
    ownerIdRef,
    persistDraftSnapshot,
    threadId,
  ]);

  const persistSettledDraft = useCallback(
    (generation: number) => {
      if (!threadId || admissionsPendingRef.current > 0 || hydrationGenerationRef.current !== generation) return;
      // P1 R7: Capture owner identity, let revision advance
      const ownerId = ownerIdRef.current;
      const capturedThreadId = threadId;
      const snapshot = captureCurrentDraft();
      void enqueueComposerDraftSave(threadId, () => persistDraftSnapshot(snapshot, false, ownerId, capturedThreadId));
    },
    [admissionsPendingRef, captureCurrentDraft, hydrationGenerationRef, ownerIdRef, persistDraftSnapshot, threadId],
  );
  return { persistSettledDraft };
}
