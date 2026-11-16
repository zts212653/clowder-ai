import { reconcileComposerAdmission } from './composer-draft-admission';
import { registerComposerDraftFlusher } from './composer-draft-flush-registry';
import { type DurableDraftSnapshot, draftAttachmentUrls } from './durable-composer-draft-helpers';
import type { enqueueComposerDraftSave } from './durable-composer-draft-save-queue';

interface ValueRef<T> {
  current: T;
}

export interface PendingComposerAdmissionDraft {
  snapshot: DurableDraftSnapshot;
  files: File[];
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
  revisionRef: ValueRef<number>;
  captureCurrentDraft: () => DurableDraftSnapshot;
  persistDraftSnapshot: (
    snapshot: DurableDraftSnapshot,
    allowPendingAdmission?: boolean,
    boundOwnerId?: number,
    boundThreadId?: string | null,
  ) => Promise<boolean>;
  enqueueSave: typeof enqueueComposerDraftSave;
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

async function flushOrdinary(state: RegisterAdmissionFlusherOptions) {
  const snapshot = state.captureCurrentDraft();
  const ownerId = state.ownerIdRef.current;
  const persisted = await state.enqueueSave(state.threadId, () =>
    state.persistDraftSnapshot(snapshot, false, ownerId, state.threadId),
  );
  return flushResult(state, snapshot, persisted);
}

async function flushAdmission(state: RegisterAdmissionFlusherOptions) {
  await state.hydrationSettledRef.current;
  const pending = state.pendingAdmissionDraftRef.current;
  if (!pending) return flushResult(state, null, false);

  return state.enqueueSave(state.threadId, async () => {
    if (state.pendingAdmissionDraftRef.current !== pending) return flushResult(state, null, false);

    // Earlier queued saves can discover a recovery, so inspect it only when this task executes.
    const pendingRecovery = state.pendingRecoveryRef.current;
    const requiredAttachmentUrls = draftAttachmentUrls(
      [...pending.snapshot.imageUrls, ...(pendingRecovery?.snapshot.imageUrls ?? [])],
      [...pending.snapshot.preservedBlocks, ...(pendingRecovery?.snapshot.preservedBlocks ?? [])],
    );
    if (!state.admissionImagesReady(pending.files, requiredAttachmentUrls)) {
      return flushResult(state, pending.snapshot, false, false, true);
    }

    const reconciliation = pendingRecovery
      ? reconcileComposerAdmission(pending.snapshot, pendingRecovery.snapshot)
      : { snapshot: pending.snapshot, requiresConfirmation: false };

    const persisted = await state.persistDraftSnapshot(
      reconciliation.snapshot,
      true,
      pending.generation,
      state.threadId,
    );

    if (reconciliation.requiresConfirmation && persisted) {
      if (state.pendingAdmissionDraftRef.current === pending && pendingRecovery) {
        pending.reconciliationResult = {
          merged: reconciliation.snapshot,
          recoveryRevision: pendingRecovery.revision,
        };
      }
    }
    // Successful admission consumes only the recovery it inspected, including an equal-content no-op.
    if (persisted && state.pendingRecoveryRef.current === pendingRecovery) {
      state.pendingRecoveryRef.current = null;
    }

    return flushResult(state, reconciliation.snapshot, persisted, reconciliation.requiresConfirmation);
  });
}

export function registerDurableComposerDraftAdmissionFlusher(state: RegisterAdmissionFlusherOptions): () => void {
  return registerComposerDraftFlusher(state.threadId, (options) =>
    options?.admission ? flushAdmission(state) : flushOrdinary(state),
  );
}
