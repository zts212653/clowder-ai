import type { QuoteContextSource } from '@cat-cafe/shared';
import {
  projectMessageBundleReadableContent,
  sanitizeRichBlock,
} from '../cats/services/context/MessageBundleSourceProjection.js';
import type { IMessageStore, StoredMessage } from '../cats/services/stores/ports/MessageStore.js';
import { canViewMessage } from '../cats/services/stores/visibility.js';
import type { AbstractiveInput, AbstractiveMessage } from './abstractive-summary-types.js';

const MESSAGE_BATCH_CHARS = 80_000;

/** Preserve visible input and resolve quote authors without importing source bodies. */
export async function toAbstractiveMessages(
  messages: StoredMessage[],
  store: Pick<IMessageStore, 'getById'>,
): Promise<AbstractiveMessage[]> {
  return Promise.all(
    messages.map(async (message) => ({
      id: message.id,
      content: message.content,
      catId: message.catId ?? undefined,
      timestamp: message.timestamp,
      contentBlocks: message.contentBlocks,
      richBlocks: message.extra?.rich?.blocks,
      quotedAuthors: await resolveQuotedAuthors(message, store),
    })),
  );
}

async function resolveQuotedAuthors(
  message: StoredMessage,
  store: Pick<IMessageStore, 'getById'>,
): Promise<Record<string, string>> {
  const authors: Record<string, string> = {};
  for (const block of message.contentBlocks ?? []) {
    if (block.type !== 'context_attachment' || block.attachment.kind !== 'quote') continue;
    const attachment = block.attachment;
    if (attachment.source.kind === 'workspace_file' || attachment.source.kind === 'collective_message') continue;
    const source = await store.getById(attachment.source.messageId);
    if (
      source &&
      source.threadId === attachment.source.threadId &&
      source.userId === message.userId &&
      !source.deletedAt &&
      !source._tombstone &&
      canViewMessage(source, { type: 'user' })
    ) {
      authors[attachment.id] = source.catId ?? 'user';
    }
  }
  return authors;
}

interface MessagePart {
  heading: string;
  text: string;
}

function messageHeading(message: AbstractiveMessage): string {
  return `[message ${message.id}] [${new Date(message.timestamp).toISOString()}] [author ${message.catId ?? 'user'}]`;
}

function quoteCoordinate(source: QuoteContextSource): string {
  if (source.kind === 'collective_message')
    return `collective:${JSON.stringify([
      source.serviceInstanceId,
      source.collectiveId,
      source.channelId,
      source.eventId,
    ])}`;
  return source.kind === 'workspace_file' ? source.path : `${source.threadId}#${source.messageId}`;
}

function messageParts(message: AbstractiveMessage): MessagePart[] {
  const author = message.catId ?? 'user';
  const contentBlocks = message.contentBlocks ?? [];
  const readable = projectMessageBundleReadableContent({
    content: message.content,
    contentBlocks: contentBlocks.filter(
      (block) => block.type !== 'context_attachment' || block.attachment.kind !== 'quote',
    ),
    extra: { rich: { v: 1, blocks: (message.richBlocks ?? []).map(sanitizeRichBlock) } },
  });
  const parts: MessagePart[] = [{ heading: `[Body author ${author}]`, text: readable }];
  for (const block of contentBlocks) {
    if (block.type !== 'context_attachment' || block.attachment.kind !== 'quote') continue;
    const attachment = block.attachment;
    const quotedAuthor = message.quotedAuthors?.[attachment.id] ?? 'unknown (see source coordinate)';
    parts.push(
      {
        heading: `[Quoted text; author ${quotedAuthor}; source ${quoteCoordinate(attachment.source)}]`,
        text: attachment.text,
      },
      { heading: `[Comment author ${author}; outer message ${message.id}]`, text: attachment.comment ?? '' },
    );
  }
  return parts;
}

function formatMessage(message: AbstractiveMessage): string {
  return [messageHeading(message), ...messageParts(message).map((part) => `${part.heading}\n${part.text}`)].join('\n');
}

/** Whole-message prefix; one oversized message is split and acknowledged atomically. */
export function prepareAbstractiveBatch(
  input: AbstractiveInput,
): { input: AbstractiveInput; prompts: string[] } | null {
  if (input.messages.length === 0) return null;
  const contents: string[] = [];
  const messages: AbstractiveMessage[] = [];
  let length = 0;
  for (const message of input.messages) {
    const content = formatMessage(message);
    if (messages.length > 0 && length + content.length + 2 > MESSAGE_BATCH_CHARS) break;
    messages.push(message);
    contents.push(content);
    length += content.length + 2;
    if (length > MESSAGE_BATCH_CHARS) break;
  }
  const header = [
    'Summarize the following thread messages.',
    input.previousSummary ? `## Previous Summary (derived context only)\n${input.previousSummary}` : '',
    '## Messages',
  ].join('\n\n');
  const content = contents.join('\n\n');
  return { input: { ...input, messages }, prompts: fragmentPrompts(header, content, messages[0]) };
}

function fragmentPrompts(header: string, content: string, message: AbstractiveMessage): string[] {
  if (content.length <= MESSAGE_BATCH_CHARS) return [`${header}\n${content}`];
  const fragments: string[] = [];
  let current = '';
  for (const part of messageParts(message)) {
    for (const piece of splitAttributedPart(part)) {
      if (current.length + piece.length > MESSAGE_BATCH_CHARS && current) {
        fragments.push(current);
        current = '';
      }
      current += piece;
    }
  }
  if (current) fragments.push(current);
  return fragments.map(
    (fragment, index) =>
      `${header}\n${messageHeading(message)}\n[Fragment ${index + 1}/${fragments.length}]\n${fragment}`,
  );
}

/** Repeat attribution on each piece, even when it starts inside a quote/comment. */
function splitAttributedPart(part: MessagePart): string[] {
  const pieces: string[] = [];
  const room = Math.max(2, MESSAGE_BATCH_CHARS - part.heading.length - 2);
  if (!part.text) return [`${part.heading}\n\n`];
  for (let start = 0; start < part.text.length; ) {
    let end = Math.min(start + room, part.text.length);
    if (end < part.text.length && /[\uD800-\uDBFF]/.test(part.text[end - 1])) end--;
    pieces.push(`${part.heading}\n${part.text.slice(start, end)}\n`);
    start = end;
  }
  return pieces;
}
