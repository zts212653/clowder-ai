import { useCallback, useRef, useState } from 'react';
import type { ChatInputDraftSnapshot } from '../ChatInput';
import {
  ComposerDraftConfirmationRequiredError,
  ComposerDraftRecoveryBlockedError,
  prepareComposerDraftAdmission,
} from '../composer-draft-flush-registry';
import { type DurableDraftSnapshot, writeOwnerComposerDraft } from '../durable-composer-draft-helpers';
import type { FirstMessagePayload, PendingNewConversationIntent } from './first-message-admission';
import { clearNewConversationIntent } from './new-conversation-intent-store';

const DRAFT_THREAD_ID = 'default';
const EMPTY_DURABLE_DRAFT: DurableDraftSnapshot = {
  text: '',
  imageUrls: [],
  contextAttachments: [],
  preservedBlocks: [],
};

interface ValueRef<T> {
  current: T;
}

interface UseNewConversationAdmissionSendOptions {
  intentRef: ValueRef<PendingNewConversationIntent | null>;
  draftRef: ValueRef<ChatInputDraftSnapshot>;
  saveSnapshot: (intent: PendingNewConversationIntent, snapshot: ChatInputDraftSnapshot) => Promise<void>;
  persistIntent: (intent: PendingNewConversationIntent) => Promise<void>;
  submit: (payload: FirstMessagePayload) => Promise<boolean>;
  setPhasePreparing: () => void;
  setPrepareFailed: () => void;
  setPreparationCancelled: () => void;
  setDraftRecovered: () => void;
  setDraftRecoveryBlocked: () => void;
  setLocalSaveFailed: (failed: boolean) => void;
}

type DraftPreparationFailureHandlers = Pick<
  UseNewConversationAdmissionSendOptions,
  'setDraftRecovered' | 'setDraftRecoveryBlocked' | 'setLocalSaveFailed' | 'setPrepareFailed'
>;

function handleDraftPreparationFailure(error: unknown, handlers: DraftPreparationFailureHandlers): void {
  if (error instanceof ComposerDraftConfirmationRequiredError) {
    handlers.setLocalSaveFailed(false);
    handlers.setDraftRecovered();
    return;
  }
  if (error instanceof ComposerDraftRecoveryBlockedError) {
    handlers.setLocalSaveFailed(false);
    handlers.setDraftRecoveryBlocked();
    return;
  }
  handlers.setLocalSaveFailed(true);
  handlers.setPrepareFailed();
}

export async function clearAcceptedComposerDraft(intent: PendingNewConversationIntent): Promise<boolean> {
  const ticket = intent.composerDraftAdmission;
  if (!ticket) return false;
  const result = await writeOwnerComposerDraft(ticket.threadId, ticket.expectedRevision, EMPTY_DURABLE_DRAFT);
  return result.kind !== 'failed';
}

export async function clearAcceptedAdmission(
  ownerUserId: string,
  intent: PendingNewConversationIntent,
): Promise<boolean> {
  try {
    if (!(await clearAcceptedComposerDraft(intent))) return false;
    await clearNewConversationIntent(ownerUserId);
    return true;
  } catch {
    return false;
  }
}

export function useNewConversationAdmissionSend({
  intentRef,
  draftRef,
  saveSnapshot,
  persistIntent,
  submit,
  setPhasePreparing,
  setPrepareFailed,
  setPreparationCancelled,
  setDraftRecovered,
  setDraftRecoveryBlocked,
  setLocalSaveFailed,
}: UseNewConversationAdmissionSendOptions) {
  const admissionSnapshotRef = useRef<ChatInputDraftSnapshot | null>(null);
  const sendInFlightRef = useRef<Promise<boolean> | null>(null);
  const preparationRef = useRef<{ cancel: () => void } | null>(null);
  const [preparing, setPreparing] = useState(false);
  const isAdmissionPending = useCallback(() => admissionSnapshotRef.current !== null, []);
  const cancelPreparation = useCallback(() => {
    const preparation = preparationRef.current;
    if (!preparation) return false;
    preparation.cancel();
    return true;
  }, []);

  const send = useCallback(
    (payload: FirstMessagePayload): Promise<boolean> => {
      if (sendInFlightRef.current) return sendInFlightRef.current;
      const initialIntent = intentRef.current;
      if (!initialIntent) return Promise.resolve(false);
      const mirrored = draftRef.current;
      const admissionSnapshot: ChatInputDraftSnapshot = {
        text: mirrored.text || payload.content,
        files: [...(payload.images ?? mirrored.files)],
        contextAttachments: [...(payload.contextAttachments ?? mirrored.contextAttachments)],
      };
      draftRef.current = admissionSnapshot;
      admissionSnapshotRef.current = admissionSnapshot;
      setPhasePreparing();
      setPreparing(true);
      const attempt = { cancelled: false, cancel: () => {} };
      const cancellation = new Promise<boolean>((resolve) => {
        attempt.cancel = () => {
          attempt.cancelled = true;
          preparationRef.current = null;
          setPreparing(false);
          setLocalSaveFailed(false);
          setPreparationCancelled();
          resolve(false);
        };
      });
      preparationRef.current = attempt;
      const awaitPreparation = async <T>(operation: Promise<T>) => {
        const value = await operation;
        if (attempt.cancelled) throw new DOMException('Send preparation cancelled', 'AbortError');
        return value;
      };

      const work = (async () => {
        try {
          await awaitPreparation(saveSnapshot(initialIntent, admissionSnapshot));
          const ticket = await awaitPreparation(prepareComposerDraftAdmission(DRAFT_THREAD_ID));
          if (ticket.threadId !== DRAFT_THREAD_ID) throw new Error('unexpected composer draft owner');
          const currentIntent = intentRef.current;
          if (!currentIntent) throw new Error('new-conversation intent unavailable');
          await awaitPreparation(
            persistIntent({
              ...currentIntent,
              composerDraftAdmission: {
                threadId: DRAFT_THREAD_ID,
                expectedRevision: ticket.expectedRevision,
              },
            }),
          );
          // The controller now owns creation/delivery. Cancel only preparation,
          // never a request whose outcome may already have reached the server.
          preparationRef.current = null;
          setPreparing(false);
          setLocalSaveFailed(false);
          return await submit(payload);
        } catch (error) {
          if (!attempt.cancelled) {
            handleDraftPreparationFailure(error, {
              setDraftRecovered,
              setDraftRecoveryBlocked,
              setLocalSaveFailed,
              setPrepareFailed,
            });
          }
          return false;
        }
      })();
      const request = Promise.race([work, cancellation]);
      sendInFlightRef.current = request;
      void request.finally(() => {
        if (sendInFlightRef.current === request) sendInFlightRef.current = null;
        if (admissionSnapshotRef.current === admissionSnapshot) admissionSnapshotRef.current = null;
        if (preparationRef.current === attempt) {
          preparationRef.current = null;
          setPreparing(false);
        }
      });
      return request;
    },
    [
      draftRef,
      intentRef,
      persistIntent,
      saveSnapshot,
      setDraftRecovered,
      setDraftRecoveryBlocked,
      setLocalSaveFailed,
      setPhasePreparing,
      setPrepareFailed,
      setPreparationCancelled,
      submit,
    ],
  );

  return { isAdmissionPending, send, preparing, cancelPreparation };
}
