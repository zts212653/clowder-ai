import { afterEach, expect, it, vi } from 'vitest';
import {
  ComposerDraftConfirmationRequiredError,
  prepareComposerDraftAdmission,
} from '@/components/composer-draft-flush-registry';
import {
  type PendingComposerAdmissionDraft,
  registerDurableComposerDraftAdmissionFlusher,
} from '@/components/durable-composer-draft-admission-flusher';
import type { DurableDraftSnapshot } from '@/components/durable-composer-draft-helpers';
import { enqueueComposerDraftSave } from '@/components/durable-composer-draft-save-queue';

const snapshot = (text: string): DurableDraftSnapshot => ({
  text,
  imageUrls: [],
  contextAttachments: [],
  preservedBlocks: [],
});
let unregister: (() => void) | undefined;
afterEach(() => unregister?.());

it.each(['local attempt', 'first unseen remote'])('retains a replacement recovery after saving %s', async (text) => {
  const first = { snapshot: snapshot(text), revision: 6, source: 'conflict' as const };
  const newer = { snapshot: snapshot('newer unseen remote'), revision: 8, source: 'conflict' as const };
  const pendingRecoveryRef = { current: first as typeof first | null };
  const pendingAdmissionDraftRef = {
    current: {
      snapshot: snapshot('local attempt'),
      files: [],
      generation: 1,
      threadId: 'recovery-consumption',
    } as PendingComposerAdmissionDraft | null,
  };
  const persistDraftSnapshot = vi
    .fn()
    .mockImplementationOnce(async () => {
      pendingRecoveryRef.current = newer;
      return true;
    })
    .mockResolvedValue(true);
  unregister = registerDurableComposerDraftAdmissionFlusher({
    threadId: 'recovery-consumption',
    hydrationSettledRef: { current: Promise.resolve() },
    ownerIdRef: { current: 1 },
    pendingAdmissionDraftRef,
    canonicalDraftRef: { current: null },
    pendingRecoveryRef,
    admissionImagesReady: () => true,
    revisionRef: { current: 8 },
    captureCurrentDraft: () => snapshot('local attempt'),
    persistDraftSnapshot,
    enqueueSave: enqueueComposerDraftSave,
  });
  const result = await prepareComposerDraftAdmission('recovery-consumption').then(
    () => 'admitted',
    (error: unknown) => error,
  );
  if (text === 'local attempt') expect(result).toBe('admitted');
  else expect(result).toBeInstanceOf(ComposerDraftConfirmationRequiredError);
  expect(pendingRecoveryRef.current).toBe(newer);
  await expect(prepareComposerDraftAdmission('recovery-consumption')).rejects.toBeInstanceOf(
    ComposerDraftConfirmationRequiredError,
  );
  expect(persistDraftSnapshot.mock.calls.at(-1)?.[0].text).toContain('newer unseen remote');
  expect(pendingRecoveryRef.current).toBeNull();
});
