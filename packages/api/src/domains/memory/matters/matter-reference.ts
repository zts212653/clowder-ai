import type { MatterSourcePointer, MatterSourcePointerInput, ReadRef } from '@cat-cafe/shared';
import { messageFrom } from '../../cats/services/stores/message-from.js';
import type { StoredMessage } from '../../cats/services/stores/ports/MessageStore.js';
import { messageContentRevision } from '../message-search-content.js';
import {
  canReadMatterThread,
  type MatterActor,
  MatterMemoryError,
  type MatterSourceReaders,
  matterDigest,
  readMatterMessage,
} from './matter-source.js';

function messagePointer(
  message: StoredMessage,
  origin: MatterSourcePointer['origin'],
): Extract<MatterSourcePointer, { kind: 'message' }> {
  return {
    kind: 'message',
    threadId: message.threadId,
    messageId: message.id,
    origin,
    author: messageFrom(message),
    timestamp: message.timestamp,
    // Raw snapshot changes and the reader's normalized citation version serve different purposes.
    sourceRevision: matterDigest([
      message.content,
      message.contentBlocks,
      message.extra?.rich?.blocks,
      messageFrom(message),
    ]),
    contentRevision: messageContentRevision({
      content: message.content,
      contentBlocks: message.contentBlocks,
      richBlocks: message.extra?.rich?.blocks,
    }),
  };
}

export async function captureMatterPointer(
  readers: MatterSourceReaders,
  actor: MatterActor,
  input: MatterSourcePointerInput,
): Promise<MatterSourcePointer> {
  if (input.messageId) {
    const message = await readMatterMessage(readers, actor, { threadId: input.threadId, messageId: input.messageId });
    if (!message) throw new MatterMemoryError('not_available');
    return messagePointer(message, 'explicit');
  }
  if (!(await canReadMatterThread(readers, actor, input.threadId))) throw new MatterMemoryError('not_available');
  return { kind: 'thread', threadId: input.threadId, origin: 'explicit' };
}

export async function captureMatterInvocation(
  readers: MatterSourceReaders,
  actor: MatterActor,
): Promise<MatterSourcePointer> {
  const invocation = actor.invocation;
  if (!invocation || !(await canReadMatterThread(readers, actor, invocation.threadId)))
    throw new MatterMemoryError('not_available');
  if (invocation.triggerMessageId) {
    const message = await readMatterMessage(readers, actor, {
      threadId: invocation.threadId,
      messageId: invocation.triggerMessageId,
    });
    if (message) return messagePointer(message, 'invocation');
  }
  return { kind: 'thread', threadId: invocation.threadId, origin: 'invocation' };
}

export async function projectMatterPointer(
  readers: MatterSourceReaders,
  actor: MatterActor,
  pointer: MatterSourcePointer,
): Promise<{ sourceStatus: 'current' | 'changed' | 'thread_only' } | null> {
  if (pointer.kind === 'thread')
    return (await canReadMatterThread(readers, actor, pointer.threadId)) ? { sourceStatus: 'thread_only' } : null;
  const message = await readMatterMessage(readers, actor, pointer);
  if (!message) return null;
  return {
    sourceStatus:
      messagePointer(message, pointer.origin).sourceRevision === pointer.sourceRevision ? 'current' : 'changed',
  };
}

export function matterEntryReadRef(source: import('@cat-cafe/shared').MatterSourceReference): ReadRef | undefined {
  if ('kind' in source)
    return source.kind === 'message'
      ? {
          kind: 'message',
          threadId: source.threadId,
          messageId: source.messageId,
          expectedRevision: source.contentRevision,
        }
      : undefined;
  return {
    kind: 'message',
    threadId: source.threadId,
    messageId: source.messageId,
    sourceSelection: {
      segment: source.segment,
      start: source.start,
      end: source.end,
      expectedRevision: source.sourceRevision,
      ...(source.contentBlockIndex !== undefined ? { contentBlockIndex: source.contentBlockIndex } : {}),
      ...(source.attachmentId ? { attachmentId: source.attachmentId } : {}),
    },
  };
}
