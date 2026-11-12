import {
  isTargetResponseRecord,
  isTargetResponseTerminal,
  type TargetResponseRecord,
  type TargetResponseResult,
} from '@cat-cafe/shared';
import type { IMessageStore, StoredMessage } from '../../cats/services/stores/ports/MessageStore.js';
import { MessagingError } from '../contract/host-types.js';

export async function advanceTargetResponse(
  store: IMessageStore,
  carrierId: string,
  update: { status: TargetResponseRecord['status']; resultMessageId?: string },
): Promise<StoredMessage> {
  for (let attempt = 0; attempt < 8; attempt++) {
    const carrier = await store.getById(carrierId);
    const prior = carrier?.extra?.targetResponse;
    if (!carrier || carrier.recall || !isTargetResponseRecord(prior))
      throw new MessagingError('NOT_FOUND', 'target response is unavailable');
    // Acceptance is a transport fact. It never overwrites a reply or terminal result.
    // Publication may resume an earlier accepted result after a later result finished.
    // It may publish content, but never rewrite the delivery's authoritative terminal outcome.
    if (isTargetResponseTerminal(prior.status)) return carrier;
    if (['waiting', 'unconfirmed'].includes(update.status) && prior.status !== 'delivering') return carrier;
    const changed = await store.compareAndSetTargetResponse(carrierId, prior.revision, {
      ...prior,
      ...update,
      revision: prior.revision + 1,
      updatedAt: Date.now(),
    });
    if (changed) return changed;
  }
  throw new MessagingError('CONFLICT', 'target response changed concurrently');
}

export async function resolveTargetResponse(
  store: IMessageStore,
  instanceId: string,
  threadId: string,
  replyTo: unknown,
  value: unknown,
): Promise<TargetResponseResult | undefined> {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new MessagingError('VALIDATION', 'response must be an object');
  const candidate = value as Record<string, unknown>;
  if (
    Object.keys(candidate).some((key) => key !== 'deliveryId' && key !== 'status') ||
    typeof candidate.deliveryId !== 'string' ||
    !candidate.deliveryId ||
    candidate.deliveryId.length > 128 ||
    !['processing', 'completed', 'failed', 'canceled', 'interrupted'].includes(candidate.status as string) ||
    typeof replyTo !== 'string'
  )
    throw new MessagingError('VALIDATION', 'response needs exact delivery, parent and status');
  let carrier = await store.getByIdempotencyKey('system', threadId, `plugin-addressed:${candidate.deliveryId}`);
  const parent = await store.getById(replyTo);
  if (
    carrier &&
    carrier.from?.kind === 'system' &&
    carrier.from.service === 'plugin_delivery' &&
    parent &&
    parent.threadId === threadId &&
    !parent.recall &&
    parent.visibility !== 'whisper' &&
    parent.lifecycle?.dispatchRefs?.filter((ref) => ref.targetId === instanceId).length === 1 &&
    parent.lifecycle.dispatchRefs.some((ref) => ref.targetId === instanceId && ref.statusMessageId === carrier!.id) &&
    !carrier.extra?.targetResponse &&
    carrier.extra?.pluginAddressedReceipt?.targetId === instanceId &&
    carrier.extra.pluginAddressedReceipt.inputMessageId === replyTo &&
    typeof replyTo === 'string'
  ) {
    const receipt = carrier.extra.pluginAddressedReceipt;
    await store.compareAndSetTargetResponse(carrier.id, 0, {
      v: 1,
      revision: 1,
      inputMessageId: replyTo,
      targetId: instanceId,
      execution: { kind: 'plugin', id: candidate.deliveryId },
      status: receipt.accepted ? 'waiting' : 'unconfirmed',
      startedAt: carrier.timestamp,
      updatedAt: Date.now(),
    });
    carrier = await store.getById(carrier.id);
  }
  const state = carrier?.extra?.targetResponse;
  if (
    !carrier ||
    carrier.from?.kind !== 'system' ||
    carrier.from.service !== 'plugin_delivery' ||
    carrier.recall ||
    !isTargetResponseRecord(state) ||
    state.targetId !== instanceId ||
    state.execution.id !== candidate.deliveryId ||
    state.inputMessageId !== replyTo ||
    !parent ||
    parent.threadId !== threadId ||
    parent.recall ||
    parent.visibility === 'whisper' ||
    parent.lifecycle?.dispatchRefs?.filter((ref) => ref.targetId === instanceId).length !== 1 ||
    !parent.lifecycle.dispatchRefs.some((ref) => ref.targetId === instanceId && ref.statusMessageId === carrier.id)
  )
    throw new MessagingError('PERMISSION', 'response does not belong to this delivery');
  return {
    carrierMessageId: carrier.id,
    deliveryId: candidate.deliveryId,
    status: candidate.status as TargetResponseResult['status'],
  };
}

/** Only new sends need an open outcome; accepted replays retain their original receipt. */
export async function assertTargetResponseOpen(store: IMessageStore, result: TargetResponseResult) {
  const carrier = await store.getById(result.carrierMessageId);
  const state = carrier?.extra?.targetResponse;
  if (!isTargetResponseRecord(state)) throw new MessagingError('NOT_FOUND', 'target response is unavailable');
  if (isTargetResponseTerminal(state.status) && state.status !== result.status)
    throw new MessagingError('CONFLICT', 'a terminal response cannot be reopened');
}

/** Both immediate and deferred publication recover this idempotently from the stored result. */
export async function settlePublishedTargetResponse(store: IMessageStore, message: StoredMessage) {
  const result = message.extra?.targetResponseResult;
  if (!result || message.from?.kind !== 'plugin' || !message.replyTo || message.visibility === 'whisper')
    return undefined;
  const carrier = await store.getById(result.carrierMessageId);
  const state = carrier?.extra?.targetResponse;
  if (
    !isTargetResponseRecord(state) ||
    state.targetId !== message.from.instanceId ||
    state.execution.id !== result.deliveryId ||
    state.inputMessageId !== message.replyTo ||
    carrier?.threadId !== message.threadId
  )
    throw new MessagingError('PERMISSION', 'stored result identity mismatch');
  return advanceTargetResponse(store, carrier!.id, { status: result.status, resultMessageId: message.id });
}
