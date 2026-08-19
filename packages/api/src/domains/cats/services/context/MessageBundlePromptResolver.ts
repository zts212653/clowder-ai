import type { MessageBundleCarrierV1 } from '@cat-cafe/shared';
import type { IMessageStore } from '../stores/ports/MessageStore.js';
import type { IThreadStore } from '../stores/ports/ThreadStore.js';
import {
  type MessageSelectionProjectedItem,
  MessageSelectionResolver,
  type ResolvedMessageSelectionItem,
} from './MessageSelectionResolver.js';

export const MESSAGE_BUNDLE_PROMPT_CHAR_LIMIT = 48_000;

export class MessageBundlePromptUnavailableError extends Error {
  constructor(reason: string) {
    super(`Message Bundle prompt unavailable: ${reason}`);
    this.name = 'MessageBundlePromptUnavailableError';
  }
}

export type MessageBundlePromptUnavailableReason = 'invalid_carrier' | 'all_unavailable' | 'prompt_too_large';

export type MessageBundlePromptResult =
  | {
      status: 'ready';
      content: string;
      items: MessageSelectionProjectedItem[];
    }
  | {
      status: 'unavailable';
      reason: MessageBundlePromptUnavailableReason;
      items: MessageSelectionProjectedItem[];
    };

interface ResolveMessageBundlePromptInput {
  bundleMessageId: string;
  forwarderUserId: string;
  carrier: MessageBundleCarrierV1;
  messageStore: Pick<IMessageStore, 'getById' | 'getByThreadAfter'>;
  threadStore: Pick<IThreadStore, 'get'>;
}

function formatAuthor(item: ResolvedMessageSelectionItem): string {
  return item.author.kind === 'cat' ? `cat:@${item.author.catId}` : `user:${item.author.userId}`;
}

function formatExactRef(item: MessageBundleCarrierV1['items'][number]): string {
  if (item.kind === 'cli_quote') {
    return `${item.messageId}#cli:${item.segmentId}:${item.selectionStart}-${item.selectionEnd}`;
  }
  if (item.kind === 'rich_block') return `${item.messageId}#rich:${item.blockId}`;
  if (item.kind === 'quote') return `${item.messageId}#quote:${item.selectionStart}-${item.selectionEnd}`;
  return item.messageId;
}

function formatItem(item: MessageSelectionProjectedItem, index: number, forwarderUserId: string): string {
  const lines = [`## Item ${index + 1}`, `Source message ref: ${item.messageId}`];
  if (item.status === 'tombstone') {
    lines.push(`Status: unavailable (${item.reason})`);
    return lines.join('\n');
  }

  lines.push(
    `Kind: ${item.kind}`,
    `Source author: ${formatAuthor(item)}`,
    `Source time: ${new Date(item.timestamp).toISOString()}`,
    'Source content:',
    item.readableContent,
  );
  if (item.comment) {
    lines.push(`Forwarder comment by user:${forwarderUserId}:`, item.comment);
  }
  return lines.join('\n');
}

/**
 * Resolve the refs-only carrier immediately before model consumption.
 * The durable target body remains a safe summary; this projection is ephemeral.
 */
export async function resolveMessageBundlePrompt(
  input: ResolveMessageBundlePromptInput,
): Promise<MessageBundlePromptResult> {
  const resolver = new MessageSelectionResolver({
    messageStore: input.messageStore,
    threadStore: input.threadStore,
  });
  const resolved = await resolver.resolveCarrier(input.carrier, { userId: input.forwarderUserId });
  if (resolved.status === 'invalid') {
    return { status: 'unavailable', reason: 'invalid_carrier', items: [] };
  }
  if (!resolved.items.some((item) => item.status === 'available')) {
    return { status: 'unavailable', reason: 'all_unavailable', items: resolved.items };
  }

  const sourceLabel = resolved.sourceThread
    ? `${JSON.stringify(resolved.sourceThread.title)} (${resolved.sourceThread.id})`
    : input.carrier.sourceThreadId;
  const content = [
    '[Message Bundle]',
    `Bundle ID: ${input.bundleMessageId}`,
    `Source thread: ${sourceLabel}`,
    `Exact refs: ${input.carrier.items.map(formatExactRef).join(', ')}`,
    '',
    ...(resolved.note ? [`Bundle note by user:${input.forwarderUserId}:`, resolved.note, ''] : []),
    ...resolved.items.flatMap((item, index) => [formatItem(item, index, input.forwarderUserId), '']),
    '[/Message Bundle]',
  ].join('\n');

  if (content.length > MESSAGE_BUNDLE_PROMPT_CHAR_LIMIT) {
    return { status: 'unavailable', reason: 'prompt_too_large', items: resolved.items };
  }
  return { status: 'ready', content, items: resolved.items };
}
