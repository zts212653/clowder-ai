import { reconcileComposerAdmission } from './composer-draft-admission';
import { registerComposerDraftFlusher } from './composer-draft-flush-registry';
import type { DurableDraftSnapshot } from './durable-composer-draft-helpers';

interface ValueRef<T> {
  current: T;
}

export interface PendingComposerAdmissionDraft {
  snapshot: DurableDraftSnapshot;
  files: File[];
  confirmsRecoveredDraft: boolean;
}

interface RegisterAdmissionFlusherOptions {
  threadId: string;
  hydrationSettledRef: ValueRef<Promise<void>>;
  pendingAdmissionDraftRef: ValueRef<PendingComposerAdmissionDraft | null>;
  canonicalDraftRef: ValueRef<DurableDraftSnapshot | null>;
  admissionImagesReady: (pendingFiles: readonly File[], requiredUrls: readonly string[]) => boolean;
  recoveredDraftAwaitingConfirmationRef: ValueRef<boolean>;
  revisionRef: ValueRef<number>;
  captureCurrentDraft: () => DurableDraftSnapshot;
  persistDraftSnapshot: (snapshot: DurableDraftSnapshot, allowPendingAdmission?: boolean) => Promise<boolean>;
  enqueueSave: (threadId: string, save: () => Promise<boolean>) => Promise<boolean>;
}

function flushResult(
  state: RegisterAdmissionFlusherOptions,
  snapshot: DurableDraftSnapshot | null,
  persisted: boolean,
  requiresConfirmation = false,
  recoveryBlocked = false,
) {
  return {
    persisted,
    revision: state.revisionRef.current,
    requiresConfirmation,
    recoveryBlocked,
    snapshot: snapshot
      ? {
          text: snapshot.text,
          imageUrls: [...snapshot.imageUrls],
          contextAttachments: snapshot.contextAttachments,
          ...(snapshot.replyTo ? { replyToId: snapshot.replyTo } : {}),
        }
      : { text: '', contextAttachments: [] },
  };
}

async function persist(
  state: RegisterAdmissionFlusherOptions,
  snapshot: DurableDraftSnapshot,
  admission: boolean,
): Promise<boolean> {
  return state.enqueueSave(state.threadId, () => state.persistDraftSnapshot(snapshot, admission));
}

async function flushOrdinary(state: RegisterAdmissionFlusherOptions) {
  const snapshot = state.captureCurrentDraft();
  return flushResult(state, snapshot, await persist(state, snapshot, false));
}

async function flushAdmission(state: RegisterAdmissionFlusherOptions) {
  await state.hydrationSettledRef.current;
  const pending = state.pendingAdmissionDraftRef.current;
  if (!pending) return flushResult(state, null, false);
  const requiredImageUrls = [
    ...new Set([...pending.snapshot.imageUrls, ...(state.canonicalDraftRef.current?.imageUrls ?? [])]),
  ];
  if (!state.admissionImagesReady(pending.files, requiredImageUrls)) {
    return flushResult(state, pending.snapshot, false, false, true);
  }

  const reconciliation =
    !pending.confirmsRecoveredDraft && state.canonicalDraftRef.current
      ? reconcileComposerAdmission(pending.snapshot, state.canonicalDraftRef.current)
      : { snapshot: pending.snapshot, requiresConfirmation: false };
  const persisted = await persist(state, reconciliation.snapshot, true);
  if ((reconciliation.requiresConfirmation && persisted) || (pending.confirmsRecoveredDraft && !persisted)) {
    state.recoveredDraftAwaitingConfirmationRef.current = true;
  }
  return flushResult(state, reconciliation.snapshot, persisted, reconciliation.requiresConfirmation);
}

export function registerDurableComposerDraftAdmissionFlusher(state: RegisterAdmissionFlusherOptions): () => void {
  return registerComposerDraftFlusher(state.threadId, (options) =>
    options?.admission ? flushAdmission(state) : flushOrdinary(state),
  );
}
