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
  reconciliationResult?: { merged: DurableDraftSnapshot; recoveryRevision: number } | null;
  generation: number;
  threadId: string | null;
}

interface RegisterAdmissionFlusherOptions {
  threadId: string;
  hydrationSettledRef: ValueRef<Promise<void>>;
  ownerIdRef: ValueRef<number>;
  pendingAdmissionDraftRef: ValueRef<PendingComposerAdmissionDraft | null>;
  canonicalDraftRef: ValueRef<DurableDraftSnapshot | null>;
  pendingRecoveryRef: ValueRef<{
    snapshot: DurableDraftSnapshot;
    revision: number;
    source: 'hydration' | 'conflict';
  } | null>;
  admissionImagesReady: (pendingFiles: readonly File[], requiredUrls: readonly string[]) => boolean;
  recoveredDraftAwaitingConfirmationRef: ValueRef<boolean>;
  revisionRef: ValueRef<number>;
  captureCurrentDraft: () => DurableDraftSnapshot;
  persistDraftSnapshot: (
    snapshot: DurableDraftSnapshot,
    allowPendingAdmission?: boolean,
    boundOwnerId?: number,
    boundThreadId?: string | null,
  ) => Promise<boolean>;
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
  // P1-1 R8: Capture owner identity before enqueue
  const ownerId = state.ownerIdRef.current;
  const threadId = state.threadId;
  return state.enqueueSave(state.threadId, () => state.persistDraftSnapshot(snapshot, admission, ownerId, threadId));
}

async function flushOrdinary(state: RegisterAdmissionFlusherOptions) {
  const snapshot = state.captureCurrentDraft();
  return flushResult(state, snapshot, await persist(state, snapshot, false));
}

async function flushAdmission(state: RegisterAdmissionFlusherOptions) {
  await state.hydrationSettledRef.current;
  const pending = state.pendingAdmissionDraftRef.current;
  if (!pending) return flushResult(state, null, false);

  // Use attempted snapshot's images only, not canonical's stale images
  const requiredImageUrls = [...new Set(pending.snapshot.imageUrls)];
  if (!state.admissionImagesReady(pending.files, requiredImageUrls)) {
    return flushResult(state, pending.snapshot, false, false, true);
  }

  // P1-1: Check pendingRecoveryRef for unseen recovery, not signature comparison
  const pendingRecovery = state.pendingRecoveryRef.current;
  const shouldReconcile = !pending.confirmsRecoveredDraft && pendingRecovery !== null;

  const reconciliation = shouldReconcile
    ? reconcileComposerAdmission(pending.snapshot, pendingRecovery.snapshot)
    : { snapshot: pending.snapshot, requiresConfirmation: false };

  const persisted = await persist(state, reconciliation.snapshot, true);

  if (reconciliation.requiresConfirmation && persisted) {
    state.recoveredDraftAwaitingConfirmationRef.current = true;
    // P1-4: Save reconciliation result to pending admission for cleanup
    if (state.pendingAdmissionDraftRef.current === pending && pendingRecovery) {
      pending.reconciliationResult = {
        merged: reconciliation.snapshot,
        recoveryRevision: pendingRecovery.revision,
      };
    }
    // Consume pending recovery after reconciliation
    state.pendingRecoveryRef.current = null;
  } else if (pending.confirmsRecoveredDraft && !persisted) {
    state.recoveredDraftAwaitingConfirmationRef.current = true;
  }

  return flushResult(state, reconciliation.snapshot, persisted, reconciliation.requiresConfirmation);
}

export function registerDurableComposerDraftAdmissionFlusher(state: RegisterAdmissionFlusherOptions): () => void {
  return registerComposerDraftFlusher(state.threadId, (options) =>
    options?.admission ? flushAdmission(state) : flushOrdinary(state),
  );
}
