import { type MutableRefObject, useEffect } from 'react';
import { composerDraftSignature, type DurableDraftSnapshot } from './durable-composer-draft-helpers';

export interface ComposerDraftConsumption {
  threadId: string;
  expectedRevision: number;
  revision: number;
}

const consumers = new Map<string, (receipt: ComposerDraftConsumption) => void>();

/** A port to the mounted canonical owner; no second draft or receipt store. */
export function registerComposerDraftConsumption(
  threadId: string,
  consume: (receipt: ComposerDraftConsumption) => void,
) {
  consumers.set(threadId, consume);
  return () => {
    if (consumers.get(threadId) === consume) consumers.delete(threadId);
  };
}

export function acknowledgeComposerDraftConsumption(receipt: ComposerDraftConsumption): void {
  if (
    !Number.isSafeInteger(receipt.expectedRevision) ||
    receipt.expectedRevision < 0 ||
    !Number.isSafeInteger(receipt.revision) ||
    receipt.revision !== receipt.expectedRevision + 1
  )
    return;
  consumers.get(receipt.threadId)?.(receipt);
}

export function acknowledgeSendComposerDraftConsumption(
  threadId: string,
  body: { userMessageId?: string; composerDraftConsumption?: ComposerDraftConsumption } | null,
): void {
  if (body?.userMessageId && body.composerDraftConsumption?.threadId === threadId) {
    acknowledgeComposerDraftConsumption(body.composerDraftConsumption);
  }
}

export function useComposerDraftConsumption(
  threadId: string | undefined,
  revision: MutableRefObject<number>,
  canonical: MutableRefObject<DurableDraftSnapshot | null>,
  signature: MutableRefObject<string>,
): void {
  useEffect(() => {
    if (!threadId) return;
    return registerComposerDraftConsumption(threadId, (receipt) => {
      if (revision.current !== receipt.expectedRevision) return;
      revision.current = receipt.revision;
      canonical.current = { text: '', imageUrls: [], contextAttachments: [], preservedBlocks: [] };
      signature.current = composerDraftSignature('', [], [], []);
    });
  }, [canonical, revision, signature, threadId]);
}
