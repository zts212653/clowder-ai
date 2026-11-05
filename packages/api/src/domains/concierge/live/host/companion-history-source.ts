import { createHash } from 'node:crypto';
import { isLifecycleStoredMessageMetadata } from '@cat-cafe/shared';
import { liveReturnProjectionSchema } from '../../../cats/services/stores/live-result-carriers.js';
import { messageFrom } from '../../../cats/services/stores/message-from.js';
import type { IMessageStore, StoredMessage } from '../../../cats/services/stores/ports/MessageStore.js';
import { canViewMessage, isEligibleReplyParent } from '../../../cats/services/stores/visibility.js';
import { CompanionBridgeError, type CompanionOwnerClient } from '../companion-owner-client.js';

export interface CompanionHistoryOptions {
  ownerUserId: string;
  client: Pick<CompanionOwnerClient, 'request'>;
  messages: Pick<IMessageStore, 'getById' | 'getByThread' | 'getByThreadBefore'>;
  conversationThread(): Promise<string>;
  assertCurrent(): Promise<void>;
  verifyThread?(threadId: string): Promise<boolean>;
}
type ResponsePhase = 'processing' | 'completed' | 'failed' | 'canceled' | 'interrupted' | null;
const unknownResponse = () => ({ inputMessageIds: [] as string[], responsePhase: null as ResponsePhase });
export const conversationBodyRevision = (text: string): string => createHash('sha256').update(text).digest('hex');

/** Split only at a complete Unicode scalar boundary; callers never compute offsets. */
export function conversationChunk(text: string, offset: number, budget: number): string {
  let end = Math.min(text.length, offset + budget);
  const previous = text.charCodeAt(end - 1);
  const next = text.charCodeAt(end);
  if (end > offset && end < text.length && previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff)
    --end;
  return text.slice(offset, end);
}
export class CompanionHistorySource {
  constructor(readonly options: CompanionHistoryOptions) {}
  async scope(expectedThread?: string): Promise<string> {
    await this.options.assertCurrent();
    // Fresh requests resolve the current thread; an in-flight read stays bound to its verified source.
    const threadId = expectedThread ?? (await this.options.conversationThread());
    const verified = this.options.verifyThread
      ? await this.options.verifyThread(threadId)
      : (await this.options.conversationThread()) === threadId;
    if (!verified) throw new CompanionBridgeError('permission_required');
    await this.options.assertCurrent();
    return threadId;
  }
  visible(message: StoredMessage, threadId: string): boolean {
    const from = messageFrom(message);
    const queuedOwnerInput =
      message.deliveryStatus === 'queued' &&
      from.kind === 'user' &&
      from.userId === this.options.ownerUserId &&
      message.origin !== 'briefing';
    return (
      message.userId === this.options.ownerUserId &&
      message.threadId === threadId &&
      !message.recall &&
      !message._tombstone &&
      !message.deletedAt &&
      (queuedOwnerInput || isEligibleReplyParent(message, { threadId, viewer: { type: 'user' } })) &&
      canViewMessage(message, { type: 'user' })
    );
  }
  async original(id: string, threadId: string, foreignIsUnavailable = false): Promise<StoredMessage | null> {
    await this.scope(threadId);
    const message = await this.options.messages.getById(id);
    await this.scope(threadId);
    if (message && (message.userId !== this.options.ownerUserId || message.threadId !== threadId)) {
      if (foreignIsUnavailable) return null;
      throw new CompanionBridgeError('permission_required');
    }
    return message;
  }
  async response(message: StoredMessage, threadId: string) {
    if (!message.catId) return unknownResponse();
    const lifecycle = message.lifecycle;
    if (isLifecycleStoredMessageMetadata(lifecycle) && lifecycle.kind === 'response') {
      const ids = [...new Set(lifecycle.inputMessageIds)];
      if (
        ids.length === 0 ||
        ids.length > 32 ||
        lifecycle.targetId !== message.catId ||
        ids.some((id) => id.length > 256 || /[\u0000-\u001f]/.test(id))
      )
        return unknownResponse();
      for (const id of ids) {
        const input = await this.original(id, threadId, true);
        if (!input || input.catId !== null || !this.visible(input, threadId)) return unknownResponse();
      }
      return { inputMessageIds: ids, responsePhase: lifecycle.status };
    }
    const live = message.extra?.liveCompanion;
    if (!live || live.modality !== 'result' || live.role !== 'assistant' || !live.nativeTurnId)
      return unknownResponse();
    const parsed = liveReturnProjectionSchema.safeParse(live.returnProjection);
    if (!parsed.success || parsed.data.reminderForMessageIds !== undefined || !parsed.data.requestRefs.length)
      return unknownResponse();
    const ids: string[] = [];
    for (const ref of parsed.data.requestRefs) {
      const qualified = `thread:${threadId}#`;
      const id = ref.startsWith(qualified)
        ? ref.slice(qualified.length)
        : ref.startsWith(`${threadId}#`)
          ? ref.slice(threadId.length + 1)
          : ref.includes('#') || ref.startsWith('thread:')
            ? null
            : ref;
      if (!id) return unknownResponse();
      const input = await this.original(id, threadId, true);
      if (
        !input ||
        input.catId !== null ||
        !this.visible(input, threadId) ||
        input.extra?.liveCompanion?.callId !== live.callId
      )
        return unknownResponse();
      ids.push(input.id);
    }
    return { inputMessageIds: [...new Set(ids)], responsePhase: 'completed' as const };
  }
}
