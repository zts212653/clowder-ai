import { isDeepStrictEqual } from 'node:util';
import type { InvocationQueue } from '../../cats/services/agents/invocation/InvocationQueue.js';
import {
  assertQueueLedgerEntry,
  queueEntryId,
} from '../../cats/services/agents/invocation/queue-ledger/QueueLedger.js';
import type { IMessageStore, StoredMessage } from '../../cats/services/stores/ports/MessageStore.js';
import type { PluginPublicInvocationCarrierV1 } from '../../cats/services/stores/ports/plugin-public-invocation-carrier.js';
import type { IThreadStore } from '../../cats/services/stores/ports/ThreadStore.js';
import { ExternalPluginRuntimeError } from '../external-runtime/types.js';
import { storedPluginMessageSource } from '../host-surface/plugin-messaging-source.js';
import { snapshotPluginProtocolData as snapshot } from './plugin-protocol-data.js';
import {
  capturePublicVerification,
  type PublicInvocationVerifierContext,
  type PublicInvocationVerifierPort,
} from './public-invocation-verifier.js';

/** Host-only coordinates from Queue or the active child registry, never a package request body. */
export interface PublicInvocationBinding {
  readonly entryId: string;
  readonly userId: string;
  readonly threadId: string;
  readonly targetCatId: string;
  /** Absent only for queued custody with no awakened child; processing requires the exact child. */
  readonly invocationId?: string;
}
export interface PublicInvocationSourceServices {
  readonly ownerUserId: string | undefined;
  readonly queue?: Pick<InvocationQueue, 'getDurableEntry'>;
  readonly messageStore: Pick<IMessageStore, 'getById'>;
  readonly threadStore: Pick<IThreadStore, 'get'> | undefined;
}
/** Internal verified snapshot; only content is projected to the provider-facing lease. */
export interface VerifiedPublicInvocationSource {
  readonly content: string;
  readonly source: unknown;
  readonly revision: number;
}
function refuse(): never {
  throw new ExternalPluginRuntimeError('DELIVERY_REJECTED', 'Public invocation source or custody is no longer current');
}
function bindingSnapshot(input: PublicInvocationBinding, owner: string | undefined, target: string) {
  const value = snapshot(input);
  if (!value || typeof value !== 'object' || Array.isArray(value)) refuse();
  const row = value as Record<string, unknown>;
  const required = ['entryId', 'userId', 'threadId', 'targetCatId'];
  if (
    required.some((key) => !(key in row)) ||
    Object.keys(row).some((key) => ![...required, 'invocationId'].includes(key)) ||
    Object.values(row).some(
      (value) =>
        typeof value !== 'string' ||
        !value.length ||
        value.length > 512 ||
        value.trim() !== value ||
        [...value].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127),
    ) ||
    !owner ||
    row.userId !== owner ||
    row.targetCatId !== target
  )
    refuse();
  return value as unknown as PublicInvocationBinding;
}
async function sourceSnapshot(
  message: StoredMessage | null,
  carrier: PluginPublicInvocationCarrierV1,
  binding: PublicInvocationBinding,
  services: PublicInvocationSourceServices,
) {
  if (
    !message ||
    message.id !== carrier.sourceMessageId ||
    message.userId !== binding.userId ||
    message.threadId !== binding.threadId ||
    message.from?.kind !== 'plugin' ||
    message.from.instanceId !== carrier.pluginInstanceId ||
    typeof message.content !== 'string' ||
    message.deletedAt ||
    message.recall ||
    message._tombstone ||
    message.sourceParseFailure ||
    (message.deliveryStatus !== 'queued' && message.deliveryStatus !== 'delivered') ||
    !storedPluginMessageSource(message)?.connector ||
    message.extra?.pluginMessage?.instanceId !== carrier.pluginInstanceId ||
    message.extra.pluginMessage.revision !== carrier.sourcePluginRevision
  )
    refuse();
  if (binding.entryId !== queueEntryId(message.id)) refuse();
  if (binding.invocationId === undefined) {
    const row = await services.queue?.getDurableEntry(binding.threadId, binding.entryId);
    if (!row) refuse();
    assertQueueLedgerEntry(row);
    if (
      row.id !== binding.entryId ||
      row.threadId !== binding.threadId ||
      row.owner.kind !== 'user' ||
      row.owner.userId !== binding.userId ||
      (row.status !== 'queued' && row.status !== 'claimed') ||
      !isDeepStrictEqual(row.execution.pluginPublicInvocation, carrier) ||
      !row.targets.includes(binding.targetCatId) ||
      row.retiringGroupId ||
      message.lifecycle?.dispatchRefs?.some((ref) => ref.targetId === binding.targetCatId)
    )
      refuse();
  } else {
    const ref = message.lifecycle?.dispatchRefs?.find((ref) => ref.targetId === binding.targetCatId);
    if (!ref || ref.phase !== 'dispatched') refuse();
    const response = await services.messageStore.getById(ref.statusMessageId);
    const lifecycle = response?.lifecycle;
    if (
      !response ||
      response.userId !== binding.userId ||
      response.threadId !== binding.threadId ||
      lifecycle?.kind !== 'response' ||
      lifecycle.invocationId !== binding.invocationId ||
      lifecycle.targetId !== binding.targetCatId ||
      lifecycle.status !== 'processing' ||
      !lifecycle.inputEntryIds.includes(binding.entryId) ||
      !lifecycle.inputMessageIds.includes(message.id)
    )
      refuse();
  }
  // Mutable Queue progress is checked above, not pinned as source content. No private extra is returned.
  return snapshot({
    content: message.content,
    source: storedPluginMessageSource(message),
    revision: carrier.sourcePluginRevision,
  }) as VerifiedPublicInvocationSource;
}

/** Read-only execution fence. This cannot admit, schedule, repair or revive a carrier. */
export async function readDurablePublicInvocationCurrent(
  instanceId: string,
  input: PluginPublicInvocationCarrierV1,
  expected: PublicInvocationBinding,
  authority: PublicInvocationVerifierContext,
  services: PublicInvocationSourceServices | undefined,
  verify: PublicInvocationVerifierPort['invokePublicInvocationVerifier'],
): Promise<VerifiedPublicInvocationSource> {
  const { carrier, context } = capturePublicVerification(instanceId, input, authority);
  const binding = bindingSnapshot(expected, services?.ownerUserId, carrier.targetCatId);
  const messages = services?.messageStore;
  const threads = services?.threadStore;
  if (!messages || !threads)
    throw new ExternalPluginRuntimeError('UNSUPPORTED_TRANSPORT', 'Public invocation source stores unavailable');
  const lifetime = new AbortController();
  const signal = AbortSignal.any([context.signal, lifetime.signal]);
  let initialSource: VerifiedPublicInvocationSource | undefined;
  let capturedSource = false;
  const outerCurrent = async () => {
    signal.throwIfAborted();
    await context.assertCurrent();
    signal.throwIfAborted();
  };
  const read = async () => {
    await outerCurrent();
    const source = await sourceSnapshot(await messages.getById(carrier.sourceMessageId), carrier, binding, services!);
    await outerCurrent();
    const thread = await threads.get(binding.threadId);
    await outerCurrent();
    if (
      !thread ||
      thread.id !== binding.threadId ||
      thread.createdBy !== binding.userId ||
      thread.deletedAt ||
      !thread.participants.some((catId) => catId === binding.targetCatId)
    )
      refuse();
    return source;
  };
  const assertCurrent = async () => {
    try {
      const before = await read();
      const after = await read();
      if (!isDeepStrictEqual(before, after) || (capturedSource && !isDeepStrictEqual(initialSource, after))) refuse();
      initialSource = after;
      capturedSource = true;
    } catch (error) {
      // An inner verifier cannot swallow a failed source fence and later approve this call.
      lifetime.abort(error);
      throw error;
    }
  };
  let removeAbortListener = () => {};
  const aborted = new Promise<never>((_, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    removeAbortListener = () => signal.removeEventListener('abort', onAbort);
    if (signal.aborted) onAbort();
  });
  try {
    return await Promise.race([
      (async () => {
        await assertCurrent();
        await verify(instanceId, carrier, Object.freeze({ signal, assertCurrent }));
        await assertCurrent();
        if (!initialSource) refuse();
        return initialSource;
      })(),
      aborted,
    ]);
  } finally {
    removeAbortListener();
    lifetime.abort();
  }
}

/** Existing callers need only a fence; launch preparation consumes the same verified read. */
export async function assertDurablePublicInvocationCurrent(
  ...args: Parameters<typeof readDurablePublicInvocationCurrent>
): Promise<void> {
  await readDurablePublicInvocationCurrent(...args);
}
