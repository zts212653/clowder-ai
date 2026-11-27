import { createHash } from 'node:crypto';
import { createCatId } from '@cat-cafe/shared';
import { z } from 'zod';
import {
  canReadMemorySourceThread,
  type MemorySourceActor,
  type MemorySourceReaders,
  readMemorySourceMessage,
} from '../../../cats/services/session/memory/memory-source-access.js';
import { messageContentRevision } from '../../../cats/services/stores/message-content-projection.js';
import { messageFrom } from '../../../cats/services/stores/message-from.js';
import { currentPluginCallContext, type PluginCallContext } from '../../carrier/plugin-call-context.js';

const sourceRef = z.string().min(1).max(200);

/** Canonical source access for the admitted memory worker, bound to the active request. */
export function createMemorySourceHost(
  options: MemorySourceReaders & {
    pluginInstanceId: string;
    assertActivation(): void;
    onMatterChanged?(ownerUserId: string): void;
  },
) {
  async function withinCall<T>(work: (actor: MemorySourceActor, caller: PluginCallContext) => Promise<T>) {
    options.assertActivation();
    const caller = currentPluginCallContext(options.pluginInstanceId);
    if (!caller) throw new Error('memory_source_access_denied');
    await caller.assertCurrent();
    const value = await work(
      {
        userId: caller.userId,
        viewer: caller.catId === 'user' ? { type: 'user' } : { type: 'cat', catId: createCatId(caller.catId) },
        publicReply: caller.memoryPublicReply,
      },
      caller,
    );
    await caller.assertCurrent();
    options.assertActivation();
    return value;
  }

  return {
    async caller() {
      return withinCall(async ({ userId, viewer, publicReply }, caller) => ({
        userId,
        viewer,
        publicReply,
        privateOwnerAccess: caller.memoryPrivateOwnerAccess === true,
        threadId: caller.threadId,
        invocationId: caller.invocationId,
        triggerMessageId: caller.originTriggerMessageId,
      }));
    },
    async assertCurrent() {
      await withinCall(async () => undefined);
    },
    async publishMatterChange() {
      await withinCall(async ({ userId }) => options.onMatterChanged?.(userId));
    },
    async canReadThread(threadId: string) {
      const ref = sourceRef.parse(threadId);
      return withinCall((actor) => canReadMemorySourceThread(options, actor, ref));
    },
    async readMessage(threadId: string, messageId: string) {
      const coordinate = { threadId: sourceRef.parse(threadId), messageId: sourceRef.parse(messageId) };
      return withinCall(async (actor) => {
        const message = await readMemorySourceMessage(options, actor, coordinate);
        if (!message) return null;
        const { content, contentBlocks, timestamp } = message;
        const richBlocks = message.extra?.rich?.blocks;
        const author = messageFrom(message);
        const rawRevision = createHash('sha256')
          .update(JSON.stringify([content, contentBlocks, richBlocks, author]))
          .digest('hex');
        return {
          ...coordinate,
          author,
          timestamp,
          content,
          contentBlocks: contentBlocks?.map((block) =>
            block.type === 'text' || (block.type === 'context_attachment' && block.attachment.kind === 'quote')
              ? block
              : { type: 'other' as const },
          ),
          sourceRevision: `sha256:${rawRevision}`,
          contentRevision: messageContentRevision({ content, contentBlocks, richBlocks }),
        };
      });
    },
    async currentTrigger() {
      return withinCall(async (actor, caller) => {
        if (!caller.originTriggerMessageId) return { status: 'ordinary' as const };
        const source = await options.messageStore.getById(caller.originTriggerMessageId);
        if (source?.visibility !== 'whisper') return { status: 'ordinary' as const };
        const coordinate = { threadId: source.threadId, messageId: source.id };
        if (!(await readMemorySourceMessage(options, actor, coordinate))) return { status: 'unavailable' as const };
        return { status: 'scoped' as const, ...coordinate };
      });
    },
  };
}
