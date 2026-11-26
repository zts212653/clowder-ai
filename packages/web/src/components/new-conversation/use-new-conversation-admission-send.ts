import { useCallback, useRef, useState } from 'react';
import type {
  ChatInputDraftSnapshot,
  FirstMessagePayload,
  PendingNewConversationIntent,
} from './first-message-admission';

interface ValueRef<T> {
  current: T;
}

interface UseNewConversationAdmissionSendOptions {
  intentRef: ValueRef<PendingNewConversationIntent | null>;
  draftRef: ValueRef<ChatInputDraftSnapshot>;
  saveSnapshot: (intent: PendingNewConversationIntent, snapshot: ChatInputDraftSnapshot) => Promise<void>;
  submit: (payload: FirstMessagePayload) => Promise<boolean>;
  setPhasePreparing: () => void;
  setPrepareFailed: () => void;
  setPreparationCancelled: () => void;
  setLocalSaveFailed: (failed: boolean) => void;
}

export function useNewConversationAdmissionSend({
  intentRef,
  draftRef,
  saveSnapshot,
  submit,
  setPhasePreparing,
  setPrepareFailed,
  setPreparationCancelled,
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
          // The controller now owns creation/delivery. Cancel only preparation,
          // never a request whose outcome may already have reached the server.
          preparationRef.current = null;
          setPreparing(false);
          setLocalSaveFailed(false);
          return await submit(payload);
        } catch {
          if (!attempt.cancelled) {
            setLocalSaveFailed(true);
            setPrepareFailed();
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
      saveSnapshot,
      setLocalSaveFailed,
      setPhasePreparing,
      setPrepareFailed,
      setPreparationCancelled,
      submit,
    ],
  );

  return { isAdmissionPending, send, preparing, cancelPreparation };
}
