'use client';

import type { ContextAttachment } from '@cat-cafe/shared';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useSendMessage } from '@/hooks/useSendMessage';
import { useChatStore } from '@/stores/chatStore';
import { apiFetch } from '@/utils/api-client';
import { invalidateSidebarProjection } from '@/utils/sidebar-thread-snapshot';
import type { ChatInputDraftSnapshot } from '../ChatInput';
import {
  getThreadDraft,
  hasPendingThreadDraft,
  syncContextAttachmentDraftToStorage,
  syncDraftToStorage,
  syncReplyDraftToStorage,
  threadImageDrafts,
} from '../thread-drafts';
import {
  createFirstMessageAdmissionController,
  type FirstMessageAdmissionPhase,
  type FirstMessagePayload,
  type PendingNewConversationIntent,
} from './first-message-admission';
import { buildNewConversationCreateBody } from './new-conversation-create-request';
import { freshIntent, type HydratedAdmissionState, hydrateAdmissionState } from './new-conversation-hydration';
import { clearNewConversationIntent, saveNewConversationIntent } from './new-conversation-intent-store';
import type { SessionImportIntent } from './session-import-admission';
import {
  clearAcceptedAdmission,
  clearAcceptedComposerDraft,
  useNewConversationAdmissionSend,
} from './use-new-conversation-admission-send';
import { useNewConversationImport } from './useNewConversationImport';

const DRAFT_THREAD_ID = 'default';
const EMPTY_DRAFT: ChatInputDraftSnapshot = { text: '', files: [], contextAttachments: [] };

function definitivePreCreateRejection(status: number): boolean {
  return status === 400 || status === 403 || status === 422;
}

function restoreAttachments(files: File[], contextAttachments: ContextAttachment[]): void {
  if (files.length > 0) threadImageDrafts.set(DRAFT_THREAD_ID, [...files]);
  else threadImageDrafts.delete(DRAFT_THREAD_ID);
  syncContextAttachmentDraftToStorage(DRAFT_THREAD_ID, contextAttachments);
}

function clearDefaultDraft(): void {
  syncDraftToStorage(DRAFT_THREAD_ID, undefined);
  threadImageDrafts.delete(DRAFT_THREAD_ID);
  syncContextAttachmentDraftToStorage(DRAFT_THREAD_ID, []);
  syncReplyDraftToStorage(DRAFT_THREAD_ID, null);
}

export interface NewConversationAdmission {
  ownerUserId: string | null;
  ready: boolean;
  loadFailed: boolean;
  localSaveFailed: boolean;
  intent: PendingNewConversationIntent | null;
  phase: FirstMessageAdmissionPhase;
  uploadStatus: ReturnType<typeof useSendMessage>['uploadStatus'];
  uploadError: string | null;
  optionsLocked: boolean;
  updateTitle: (title: string) => void;
  updatePinned: (pinned: boolean) => void;
  updateProject: (projectPath: string | undefined) => void;
  updatePreferredCats: (catIds: string[]) => void;
  onDraftChange: (snapshot: ChatInputDraftSnapshot) => void;
  send: (payload: FirstMessagePayload) => Promise<boolean>;
  importSession: (selection: SessionImportIntent) => Promise<void>;
  cancelImport: () => Promise<void>;
  retryLoad: () => void;
}

export function useNewConversationAdmission(onNavigate: (threadId: string) => void): NewConversationAdmission {
  const setCurrentThread = useChatStore((state) => state.setCurrentThread);
  const setThreadHasDraft = useChatStore((state) => state.setThreadHasDraft);
  const { handleSend, uploadStatus, uploadError } = useSendMessage(DRAFT_THREAD_ID);
  const [intent, setIntent] = useState<PendingNewConversationIntent | null>(null);
  const [ready, setReady] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [localSaveFailed, setLocalSaveFailed] = useState(false);
  const [phase, setPhase] = useState<FirstMessageAdmissionPhase>('idle');
  const [loadAttempt, setLoadAttempt] = useState(0);
  const ownerRef = useRef<string | null>(null);
  const intentRef = useRef<PendingNewConversationIntent | null>(null);
  const draftRef = useRef<ChatInputDraftSnapshot>(EMPTY_DRAFT);
  const saveQueueRef = useRef<Promise<void>>(Promise.resolve());

  useLayoutEffect(() => setCurrentThread(DRAFT_THREAD_ID), [setCurrentThread]);

  const enqueue = useCallback((operation: () => Promise<void>): Promise<void> => {
    const next = saveQueueRef.current.then(operation, operation);
    saveQueueRef.current = next.catch(() => undefined);
    return next;
  }, []);

  const save = useCallback(
    (nextIntent: PendingNewConversationIntent, snapshot = draftRef.current): Promise<void> => {
      const ownerUserId = ownerRef.current;
      if (!ownerUserId) return Promise.reject(new Error('owner unavailable'));
      return enqueue(() =>
        saveNewConversationIntent({
          ownerUserId,
          intent: nextIntent,
          files: snapshot.files,
          contextAttachments: snapshot.contextAttachments,
          updatedAt: Date.now(),
        }),
      );
    },
    [enqueue],
  );

  const applyHydratedAdmission = useCallback(
    async (hydrated: HydratedAdmissionState, signal: AbortSignal) => {
      if (signal.aborted) return;
      ownerRef.current = hydrated.ownerUserId;
      saveQueueRef.current = Promise.resolve();
      restoreAttachments(hydrated.files, hydrated.contextAttachments);
      draftRef.current = {
        text: getThreadDraft(DRAFT_THREAD_ID),
        files: hydrated.files,
        contextAttachments: hydrated.contextAttachments,
      };
      intentRef.current = hydrated.intent;
      setIntent(hydrated.intent);
      setThreadHasDraft(DRAFT_THREAD_ID, hasPendingThreadDraft(DRAFT_THREAD_ID));

      if (hydrated.intent.importAccepted && hydrated.intent.createdThreadId) {
        await clearNewConversationIntent(hydrated.ownerUserId);
        void invalidateSidebarProjection();
        onNavigate(hydrated.intent.createdThreadId);
        return;
      }
      if (hydrated.intent.messageAccepted && hydrated.intent.createdThreadId) {
        const cleared = await clearAcceptedAdmission(hydrated.ownerUserId, hydrated.intent);
        if (cleared) {
          clearDefaultDraft();
          setThreadHasDraft(DRAFT_THREAD_ID, false);
        }
        void invalidateSidebarProjection();
        onNavigate(hydrated.intent.createdThreadId);
        return;
      }
      setReady(true);
    },
    [onNavigate, setThreadHasDraft],
  );

  useEffect(() => {
    void loadAttempt;
    const controller = new AbortController();
    setReady(false);
    setLoadFailed(false);
    setPhase('idle');
    void hydrateAdmissionState(controller.signal).then(
      (hydrated) => applyHydratedAdmission(hydrated, controller.signal),
      () => {
        if (!controller.signal.aborted) setLoadFailed(true);
      },
    );
    return () => controller.abort();
  }, [applyHydratedAdmission, loadAttempt]);

  const persistIntent = useCallback(
    async (nextIntent: PendingNewConversationIntent) => {
      intentRef.current = nextIntent;
      setIntent(nextIntent);
      try {
        await save(nextIntent);
        setLocalSaveFailed(false);
      } catch (error) {
        setLocalSaveFailed(true);
        throw error;
      }
    },
    [save],
  );

  const createThread = useCallback(async (current: PendingNewConversationIntent) => {
    const response = await apiFetch('/api/threads', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buildNewConversationCreateBody(current)),
    });
    if (!response.ok) {
      throw Object.assign(new Error(`thread creation failed: ${response.status}`), {
        optionsMayChange: definitivePreCreateRejection(response.status),
      });
    }
    const body = (await response.json()) as { id?: unknown };
    if (typeof body.id !== 'string' || !body.id.trim()) throw new Error('thread creation returned no id');
    return { id: body.id };
  }, []);

  const complete = useCallback(async () => {
    const ownerUserId = ownerRef.current;
    if (!ownerUserId) throw new Error('owner unavailable');
    const current = intentRef.current;
    if (!current || !(await clearAcceptedComposerDraft(current))) {
      throw new Error('accepted composer draft cleanup failed');
    }
    await enqueue(() => clearNewConversationIntent(ownerUserId));
    clearDefaultDraft();
    draftRef.current = EMPTY_DRAFT;
    setThreadHasDraft(DRAFT_THREAD_ID, false);
    await invalidateSidebarProjection();
  }, [enqueue, setThreadHasDraft]);

  const controller = useMemo(
    () =>
      createFirstMessageAdmissionController({
        readIntent: () => {
          if (!intentRef.current) throw new Error('intent unavailable');
          return intentRef.current;
        },
        persistIntent,
        createThread,
        sendMessage: (payload, threadId, idempotencyKey) =>
          handleSend(
            payload.content,
            payload.images,
            threadId,
            payload.whisper,
            payload.replyToId,
            payload.contextAttachments,
            payload.explicitTargetCats,
            {
              idempotencyKey,
              ...(payload.messageDisposition ? { messageDisposition: payload.messageDisposition } : {}),
            },
          ),
        complete,
        navigate: onNavigate,
        onPhaseChange: setPhase,
      }),
    [complete, createThread, handleSend, onNavigate, persistIntent],
  );

  const resetImportIntent = useCallback(async () => {
    const current = intentRef.current;
    if (!current?.sessionImport) return;
    await persistIntent({ ...freshIntent(current.projectPath), title: current.title, pinned: current.pinned });
  }, [persistIntent]);

  const importController = useNewConversationImport({
    intentRef,
    ownerRef,
    persistIntent,
    createThread,
    onNavigate,
    enqueue,
    setPhase,
    resetIntent: resetImportIntent,
  });

  const { isAdmissionPending, send } = useNewConversationAdmissionSend({
    intentRef,
    draftRef,
    saveSnapshot: save,
    persistIntent,
    submit: controller.send,
    setPhasePreparing: () => setPhase('creating'),
    setPrepareFailed: () => setPhase('create_failed'),
    setDraftRecovered: () => setPhase('draft_recovered'),
    setDraftRecoveryBlocked: () => setPhase('draft_recovery_blocked'),
    setLocalSaveFailed,
  });

  const updateIntent = useCallback(
    (patch: Partial<Pick<PendingNewConversationIntent, 'projectPath' | 'preferredCats' | 'title' | 'pinned'>>) => {
      const current = intentRef.current;
      if (!current || current.creationStarted) return;
      const next = { ...current, ...patch };
      intentRef.current = next;
      setIntent(next);
      void save(next).then(
        () => setLocalSaveFailed(false),
        () => setLocalSaveFailed(true),
      );
    },
    [save],
  );

  const onDraftChange = useCallback(
    (snapshot: ChatInputDraftSnapshot) => {
      if (isAdmissionPending()) return;
      draftRef.current = snapshot;
      const current = intentRef.current;
      if (!current || !ownerRef.current) return;
      void save(current, snapshot).then(
        () => setLocalSaveFailed(false),
        () => setLocalSaveFailed(true),
      );
    },
    [isAdmissionPending, save],
  );

  return {
    ownerUserId: ready ? ownerRef.current : null,
    ready,
    loadFailed,
    localSaveFailed,
    intent,
    phase,
    uploadStatus,
    uploadError,
    optionsLocked: Boolean(intent?.creationStarted || phase === 'creating' || phase === 'sending'),
    updateTitle: (title) => updateIntent({ title }),
    updatePinned: (pinned) => updateIntent({ pinned }),
    updateProject: (projectPath) => updateIntent({ projectPath }),
    updatePreferredCats: (preferredCats) => updateIntent({ preferredCats }),
    onDraftChange,
    send,
    importSession: importController.importSession,
    cancelImport: importController.cancel,
    retryLoad: () => setLoadAttempt((value) => value + 1),
  };
}
