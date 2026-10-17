import { isDeepStrictEqual } from 'node:util';
import type { InvocationQueue } from '../../cats/services/agents/invocation/InvocationQueue.js';
import { queueEntryId } from '../../cats/services/agents/invocation/queue-ledger/QueueLedger.js';
import { type IMessageStore, isDelivered, type StoredMessage } from '../../cats/services/stores/ports/MessageStore.js';
import type { IThreadStore } from '../../cats/services/stores/ports/ThreadStore.js';
import { currentPluginCallContext, currentPluginOwnerRequestContext } from '../carrier/plugin-call-context.js';
import { snapshotPluginProtocolData } from '../carrier/plugin-protocol-data.js';
import { ExternalPluginRuntimeError } from '../external-runtime/types.js';
import { storedPluginMessageSource } from './plugin-messaging-source.js';
import { type PluginSourceProgressFact, projectPluginQueueProgress } from './plugin-source-progress.js';

/** Source facts are readable data, never a grant to invoke an agent or access owner context. */
export interface PluginSourceFact {
  readonly id: string;
  readonly userId: string;
  readonly threadId: string;
  readonly catId: string | null;
  readonly content: string;
  readonly source: {
    readonly connector: string;
    readonly meta?: Readonly<Record<string, unknown>>;
  };
  readonly extra: { readonly pluginMessage: { readonly instanceId: string } };
}
export interface PluginSourceFactsHost {
  read(input: { readonly messageRef: `message:${string}` }): Promise<PluginSourceFact>;
  readProgress(input: { readonly messageRef: `message:${string}` }): Promise<PluginSourceProgressFact>;
}
export interface PluginNativeContext {
  readonly userId: string;
  readonly threadId: string;
  readonly catId: string;
  readonly invocationId: string;
  readonly originTriggerMessageId: string;
  readonly source: PluginSourceFact;
}
export interface PluginNativeContextHost {
  current(): Promise<PluginNativeContext>;
}
interface Deps {
  readonly pluginInstanceId: string;
  readonly queue?: Pick<InvocationQueue, 'getDurableEntry'>;
  readonly ownerUserId: string | undefined;
  readonly messageStore: Pick<IMessageStore, 'getById'> | undefined;
  readonly threadStore: Pick<IThreadStore, 'get'> | undefined;
  readonly assertCurrent: (capabilities: readonly string[]) => Promise<void>;
}
function refuse(): never {
  throw new ExternalPluginRuntimeError('DELIVERY_REJECTED', 'Plugin source is unavailable to this caller');
}
function messageId(input: { readonly messageRef: `message:${string}` }): string {
  const value = snapshotPluginProtocolData(input);
  if (!value || typeof value !== 'object' || Array.isArray(value)) refuse();
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).length !== 1 ||
    typeof record.messageRef !== 'string' ||
    !/^message:\S{1,500}$/u.test(record.messageRef) ||
    [...record.messageRef].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
  )
    refuse();
  return record.messageRef.slice('message:'.length);
}

/** Exact origin only for native calls; Work/receipt/ancestor scopes require their own admission. */
export function createPluginSourceFactsHost(deps: Deps): {
  readonly sourceFacts: PluginSourceFactsHost;
  readonly nativeContext: PluginNativeContextHost;
} {
  function principal(nativeOnly = false) {
    const messages = deps.messageStore,
      threads = deps.threadStore;
    if (!deps.ownerUserId || !messages || !threads)
      throw new ExternalPluginRuntimeError('UNSUPPORTED_TRANSPORT', 'Host source stores unavailable');
    const owner = currentPluginOwnerRequestContext(deps.pluginInstanceId);
    const native = currentPluginCallContext(deps.pluginInstanceId);
    if (owner && !nativeOnly && owner.userId === deps.ownerUserId) {
      return {
        messages,
        threads,
        userId: owner.userId,
        native: undefined,
        checkCaller: () => owner.assertCurrent(),
      };
    }
    if (
      !native?.assertInvocationCurrent ||
      native.userId !== deps.ownerUserId ||
      !native.invocationId ||
      !native.originTriggerMessageId ||
      !native.catId ||
      !native.threadId
    )
      refuse();
    const identity = Object.freeze({
      userId: native.userId,
      threadId: native.threadId,
      catId: native.catId,
      invocationId: native.invocationId,
      originTriggerMessageId: native.originTriggerMessageId,
    });
    const check = native.assertInvocationCurrent;
    return { messages, threads, userId: identity.userId, native: identity, checkCaller: () => check() };
  }
  type Caller = ReturnType<typeof principal>;
  async function current(caller: Caller) {
    await caller.checkCaller();
    await deps.assertCurrent(['thread.readContent']);
    await caller.checkCaller();
  }
  async function assertReadableDelivery(message: StoredMessage, caller: Caller): Promise<void> {
    if (isDelivered(message)) return;
    const native = caller.native;
    if (!native || message.deliveryStatus !== 'queued') refuse();
    const ref = message.lifecycle?.dispatchRefs?.find((ref) => ref.targetId === native.catId);
    if (!ref || ref.phase !== 'dispatched') refuse();
    const response = await caller.messages.getById(ref.statusMessageId);
    const lifecycle = response?.lifecycle;
    if (
      !response ||
      response.userId !== caller.userId ||
      response.threadId !== message.threadId ||
      lifecycle?.kind !== 'response' ||
      lifecycle.invocationId !== native.invocationId ||
      lifecycle.targetId !== native.catId ||
      lifecycle.status !== 'processing' ||
      !lifecycle.inputMessageIds.includes(message.id) ||
      !lifecycle.inputEntryIds.includes(queueEntryId(message.id))
    )
      refuse();
  }
  function checkedSource(message: StoredMessage | null, id: string, caller: Caller) {
    if (
      !message ||
      message.id !== id ||
      message.userId !== caller.userId ||
      (caller.native &&
        (message.id !== caller.native.originTriggerMessageId || message.threadId !== caller.native.threadId)) ||
      message.deletedAt ||
      message.recall ||
      message._tombstone ||
      message.sourceParseFailure ||
      message.extra?.pluginMessage?.instanceId !== deps.pluginInstanceId ||
      !storedPluginMessageSource(message)?.connector
    )
      refuse();
    return { message, source: storedPluginMessageSource(message)!, pluginMessage: message.extra.pluginMessage };
  }
  async function sourceOf(value: StoredMessage | null, id: string, caller: Caller, progress: boolean) {
    const { message, source, pluginMessage } = checkedSource(value, id, caller);
    // A running child must read its exact queued origin to call the plugin's
    // native methods. This does not expose queued sources to owner or unrelated calls.
    if (!progress) await assertReadableDelivery(message, caller);
    const queueProgress = progress
      ? await projectPluginQueueProgress(message, caller.userId, caller.messages, deps.queue)
      : undefined;
    const projected = {
      id: message.id,
      userId: message.userId,
      threadId: message.threadId,
      catId: message.catId,
      ...(progress ? {} : { content: message.content }),
      ...(queueProgress === undefined ? {} : { queueCustody: queueProgress }),
      source: {
        connector: source.connector,
        ...(source.meta === undefined ? {} : { meta: source.meta }),
      },
      extra: { pluginMessage: { instanceId: deps.pluginInstanceId } },
    };
    return {
      fact: snapshotPluginProtocolData(projected) as PluginSourceFact | PluginSourceProgressFact,
      revision: pluginMessage.revision,
      ...(progress ? { lifecycle: message.lifecycle ?? null, deliveryStatus: message.deliveryStatus ?? null } : {}),
      // Keep the same Queue admission across both reads, including any public
      // carrier. Ordinary send(wake) uses the existing generic Queue admission.
      queueBinding: message.lifecycle?.dispatchRefs ?? null,
    };
  }
  async function readOnce(id: string, caller: Caller, progress: boolean) {
    await current(caller);
    const source = await sourceOf(await caller.messages.getById(id), id, caller, progress);
    await current(caller);
    const thread = await caller.threads.get(source.fact.threadId);
    await current(caller);
    if (!thread || thread.id !== source.fact.threadId || thread.createdBy !== caller.userId || thread.deletedAt)
      refuse();
    return source;
  }
  async function read(id: string, caller: Caller): Promise<PluginSourceFact>;
  async function read(id: string, caller: Caller, progress: true): Promise<PluginSourceProgressFact>;
  async function read(
    id: string,
    caller: Caller,
    progress = false,
  ): Promise<PluginSourceFact | PluginSourceProgressFact> {
    // Reject an out-of-scope native pointer before even asking the message store.
    if (caller.native && caller.native.originTriggerMessageId !== id) refuse();
    const before = await readOnce(id, caller, progress);
    const after = await readOnce(id, caller, progress);
    if (!isDeepStrictEqual(before, after)) refuse();
    return after.fact;
  }
  async function currentNative(input?: unknown): Promise<PluginNativeContext> {
    if (input !== undefined) refuse();
    const caller = principal(true);
    if (!caller.native) refuse();
    const source = await read(caller.native.originTriggerMessageId, caller);
    return snapshotPluginProtocolData({ ...caller.native, source }) as PluginNativeContext;
  }
  return Object.freeze({
    sourceFacts: Object.freeze({
      async read(input: { readonly messageRef: `message:${string}` }) {
        return read(messageId(input), principal());
      },
      async readProgress(input: { readonly messageRef: `message:${string}` }) {
        const caller = principal();
        if (caller.native) refuse();
        return read(messageId(input), caller, true);
      },
    }),
    nativeContext: Object.freeze({ current: currentNative }),
  });
}
