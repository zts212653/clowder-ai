'use client';

import type { ContextAttachment } from '@cat-cafe/shared';
import { type MutableRefObject, useCallback, useEffect } from 'react';
import type { DurableDraftSnapshot } from './durable-composer-draft-helpers';
import { enqueueComposerDraftSave } from './durable-composer-draft-save-queue';

interface DraftAutosaveOptions {
  threadId?: string;
  hydratedRef: MutableRefObject<boolean>;
  hydrationGenerationRef: MutableRefObject<number>;
  admissionsPendingRef: MutableRefObject<number>;
  admissionEpoch: number;
  input: string;
  images: File[];
  contextAttachments: ContextAttachment[];
  captureCurrentDraft: () => DurableDraftSnapshot;
  persistDraftSnapshot: (snapshot: DurableDraftSnapshot) => Promise<boolean>;
  persistCurrentDraft: () => Promise<boolean>;
}

/** Editing keeps its debounce; page exit and accepted sends flush through the same revisioned owner queue. */
export function useComposerDraftAutosave(options: DraftAutosaveOptions) {
  const {
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
  } = options;
  useEffect(() => {
    if (!threadId) return;
    const flush = () => {
      if (!hydratedRef.current || admissionsPendingRef.current > 0) return;
      const snapshot = captureCurrentDraft();
      void enqueueComposerDraftSave(threadId, () => persistDraftSnapshot(snapshot));
    };
    window.addEventListener('pagehide', flush);
    return () => {
      window.removeEventListener('pagehide', flush);
      flush();
    };
  }, [admissionsPendingRef, captureCurrentDraft, hydratedRef, persistDraftSnapshot, threadId]);

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
  }, [
    admissionEpoch,
    admissionsPendingRef,
    contextAttachments,
    hydratedRef,
    images,
    input,
    persistCurrentDraft,
    threadId,
  ]);

  const persistSettledDraft = useCallback(
    (generation: number) => {
      if (!threadId || admissionsPendingRef.current > 0 || hydrationGenerationRef.current !== generation) return;
      void enqueueComposerDraftSave(threadId, persistCurrentDraft);
    },
    [admissionsPendingRef, hydrationGenerationRef, persistCurrentDraft, threadId],
  );
  return { persistSettledDraft };
}
