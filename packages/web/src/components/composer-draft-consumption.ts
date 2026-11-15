import { type MutableRefObject, useEffect } from 'react';
import type { OwnerComposerDraft } from '@/stores/chat-types';
import { apiSessionIdentity } from '@/utils/api-session-identity';
import type { SendAttempt } from '@/utils/send-attempt-db';
import { composerDraftSignature, type DurableDraftSnapshot } from './durable-composer-draft-helpers';

export interface ComposerDraftConsumption {
  threadId: string;
  expectedRevision: number;
  revision: number;
}

const consumers = new Map<string, (receipt: ComposerDraftConsumption) => void>();
const recoverers = new Map<string, (draft: OwnerComposerDraft) => Promise<boolean>>();
const preparedConsumers = new Map<string, (attempt: SendAttempt) => boolean>();

/** A callback into the mounted draft owner, never a second content store. */
export function registerPreparedComposerDraftConsumer(
  ownerUserId: string,
  threadId: string,
  consume: (attempt: SendAttempt) => boolean,
) {
  const key = JSON.stringify([ownerUserId, threadId]);
  preparedConsumers.set(key, consume);
  return () => {
    if (preparedConsumers.get(key) === consume) preparedConsumers.delete(key);
  };
}

export function consumePreparedComposerDraft(attempt: SendAttempt): boolean {
  if (apiSessionIdentity.getSnapshot().ownerUserId !== attempt.ownerUserId) return false;
  return preparedConsumers.get(JSON.stringify([attempt.ownerUserId, attempt.threadId]))?.(attempt) ?? false;
}

/** Transfer a recalled draft to its mounted owner; this port stores no content. */
export function registerComposerDraftRecovery(
  threadId: string,
  recover: (draft: OwnerComposerDraft) => Promise<boolean>,
) {
  recoverers.set(threadId, recover);
  return () => {
    if (recoverers.get(threadId) === recover) recoverers.delete(threadId);
  };
}
export async function recoverMountedComposerDraft(draft: OwnerComposerDraft) {
  return (await recoverers.get(draft.threadId)?.(draft)) ?? false;
}

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
