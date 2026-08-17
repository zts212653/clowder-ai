import { createHash } from 'node:crypto';
import {
  MESSAGE_BUNDLE_QUOTE_DIGEST_DOMAIN,
  MESSAGE_BUNDLE_QUOTE_PROJECTION_VERSION,
  MESSAGE_BUNDLE_VERSION,
  type MessageBundleCarrierV1,
  MessageBundleCarrierV1Schema,
  type MessageBundleItemV1,
  type MessageBundleSelectionItem,
  MessageBundleSelectionSchema,
  type MessageContent,
  type RichBlock,
} from '@cat-cafe/shared';
import type { IMessageStore, StoredMessage } from '../stores/ports/MessageStore.js';
import type { IThreadStore, Thread } from '../stores/ports/ThreadStore.js';
import { canViewMessage, getTimelineOrderTime, isTimelinePublished } from '../stores/visibility.js';

export { MESSAGE_BUNDLE_QUOTE_DIGEST_DOMAIN };

export interface MessageSelectionAuth {
  userId: string;
}

export type MessageSelectionInvalidReason =
  | 'invalid_selection'
  | 'not_authorized'
  | 'source_unavailable'
  | 'quote_mismatch'
  | 'ambiguous_quote';

export type MessageSelectionTombstoneReason = 'source_unavailable' | 'source_changed';

export type MessageSelectionAuthor = { kind: 'user'; userId: string } | { kind: 'cat'; catId: string };

export interface ResolvedMessageSelectionItem {
  status: 'available';
  kind: 'message' | 'quote';
  messageId: string;
  sourceThreadId: string;
  author: MessageSelectionAuthor;
  timestamp: number;
  readableContent: string;
  comment?: string;
}

export interface MessageSelectionTombstone {
  status: 'tombstone';
  messageId: string;
  reason: MessageSelectionTombstoneReason;
}

export type MessageSelectionProjectedItem = ResolvedMessageSelectionItem | MessageSelectionTombstone;

export type MessageSelectionAdmissionResult =
  | {
      status: 'resolved';
      sourceThread: Pick<Thread, 'id' | 'title'>;
      carrier: MessageBundleCarrierV1;
      items: ResolvedMessageSelectionItem[];
    }
  | { status: 'invalid'; reason: MessageSelectionInvalidReason; messageId?: string };

export type MessageSelectionReadResult =
  | {
      status: 'resolved';
      sourceThread: Pick<Thread, 'id' | 'title'> | null;
      items: MessageSelectionProjectedItem[];
    }
  | { status: 'invalid'; reason: 'invalid_carrier' };

interface MessageSelectionResolverDeps {
  messageStore: Pick<IMessageStore, 'getById'>;
  threadStore: Pick<IThreadStore, 'get'>;
}

interface AdmissionCandidate {
  message: StoredMessage;
  carrierItem: MessageBundleItemV1;
  projectedItem: ResolvedMessageSelectionItem;
}

export function digestMessageBundleQuoteProjection(projection: string): string {
  return createHash('sha256')
    .update(MESSAGE_BUNDLE_QUOTE_DIGEST_DOMAIN, 'utf8')
    .update(projection, 'utf8')
    .digest('hex');
}

function readContentBlockFallback(block: MessageContent): string | null {
  switch (block.type) {
    case 'text':
      return block.text;
    case 'image':
      return block.alt?.trim() ? `[图片: ${block.alt.trim()}]` : '[图片]';
    case 'file':
      return `[文件: ${block.fileName}]`;
    case 'code': {
      const heading = block.filename?.trim() ? `[代码: ${block.filename.trim()}]` : '[代码]';
      return `${heading}\n${block.code}`;
    }
    case 'context_attachment': {
      const attachment = block.attachment;
      if (attachment.kind === 'quote') return `[引用]\n${attachment.text}`;
      if (attachment.kind === 'thread') return `[对话: ${attachment.title}]`;
      return `[文件: ${attachment.path}]`;
    }
    case 'tool_call':
    case 'tool_result':
      return null;
  }
}

function readRichBlockFallback(block: RichBlock): string | null {
  switch (block.kind) {
    case 'card': {
      const lines = [`[卡片: ${block.title}]`];
      if (block.bodyMarkdown?.trim()) lines.push(block.bodyMarkdown.trim());
      for (const field of block.fields ?? []) lines.push(`${field.label}: ${field.value}`);
      return lines.join('\n');
    }
    case 'diff':
      return `[Diff: ${block.filePath}]\n${block.diff}`;
    case 'checklist': {
      const lines = [`[清单${block.title?.trim() ? `: ${block.title.trim()}` : ''}]`];
      lines.push(...block.items.map((item) => `${item.checked ? '[x]' : '[ ]'} ${item.text}`));
      return lines.join('\n');
    }
    case 'media_gallery': {
      const lines = [`[图片集${block.title?.trim() ? `: ${block.title.trim()}` : ''}]`];
      lines.push(...block.items.map((item) => item.caption?.trim() || item.alt?.trim() || '[图片]'));
      return lines.join('\n');
    }
    case 'audio': {
      const label = `[音频${block.title?.trim() ? `: ${block.title.trim()}` : ''}]`;
      return block.text?.trim() ? `${label}\n${block.text.trim()}` : label;
    }
    case 'interactive': {
      const lines = [`[交互选项${block.title?.trim() ? `: ${block.title.trim()}` : ''}]`];
      if (block.description?.trim()) lines.push(block.description.trim());
      lines.push(...block.options.map((option) => `- ${option.label}`));
      return lines.join('\n');
    }
    case 'html_widget':
      return `[交互内容${block.title?.trim() ? `: ${block.title.trim()}` : ''}]`;
    case 'file':
      return `[文件: ${block.fileName}]`;
  }
}

export function projectMessageBundleReadableContent(
  message: Pick<StoredMessage, 'content' | 'contentBlocks' | 'extra'>,
): string {
  const parts: string[] = [];
  if (message.content.trim()) parts.push(message.content);

  for (const block of message.contentBlocks ?? []) {
    const fallback = readContentBlockFallback(block);
    if (!fallback?.trim()) continue;
    if (block.type === 'text' && message.content.trim()) continue;
    parts.push(fallback);
  }

  for (const block of message.extra?.rich?.blocks ?? []) {
    const fallback = readRichBlockFallback(block);
    if (fallback?.trim()) parts.push(fallback);
  }

  return parts.join('\n');
}

export function projectMessageBundleQuoteSourceV1(
  message: Pick<StoredMessage, 'content' | 'contentBlocks' | 'extra'>,
): string {
  return projectMessageBundleReadableContent(message);
}

function authorFor(message: StoredMessage): MessageSelectionAuthor {
  return message.catId === null ? { kind: 'user', userId: message.userId } : { kind: 'cat', catId: message.catId };
}

function invalid(reason: MessageSelectionInvalidReason, messageId?: string): MessageSelectionAdmissionResult {
  return messageId ? { status: 'invalid', reason, messageId } : { status: 'invalid', reason };
}

function tombstone(messageId: string, reason: MessageSelectionTombstoneReason): MessageSelectionTombstone {
  return { status: 'tombstone', messageId, reason };
}

function canAccessSourceThread(thread: Thread | null, auth: MessageSelectionAuth): thread is Thread {
  return Boolean(thread && !thread.deletedAt && (thread.createdBy === auth.userId || thread.createdBy === 'system'));
}

function isSelectableMessage(
  message: StoredMessage | null,
  sourceThreadId: string,
  auth: MessageSelectionAuth,
): message is StoredMessage {
  return Boolean(
    message &&
      message.threadId === sourceThreadId &&
      message.userId === auth.userId &&
      message.userId !== 'system' &&
      message.userId !== 'scheduler' &&
      message.catId !== 'system' &&
      message.source === undefined &&
      message.origin !== 'briefing' &&
      message.deletedAt === undefined &&
      message._tombstone !== true &&
      message.recall === undefined &&
      message.deliveryStatus !== 'canceled' &&
      isTimelinePublished(message) &&
      canViewMessage(message, { type: 'user' }) &&
      projectMessageBundleReadableContent(message).trim().length > 0,
  );
}

function findExactMatches(text: string, evidence: string): number[] {
  const matches: number[] = [];
  let cursor = 0;
  while (cursor <= text.length - evidence.length) {
    const index = text.indexOf(evidence, cursor);
    if (index === -1) break;
    matches.push(index);
    cursor = index + 1;
  }
  return matches;
}

function quoteOffsets(
  item: Extract<MessageBundleSelectionItem, { kind: 'quote' }>,
  projection: string,
): { selectionStart: number; selectionEnd: number } | 'quote_mismatch' | 'ambiguous_quote' {
  if (
    item.selectionStart !== undefined &&
    item.selectionEnd !== undefined &&
    projection.slice(item.selectionStart, item.selectionEnd) === item.text
  ) {
    return { selectionStart: item.selectionStart, selectionEnd: item.selectionEnd };
  }

  const matches = findExactMatches(projection, item.text);
  if (matches.length === 0) return 'quote_mismatch';
  if (matches.length > 1) return 'ambiguous_quote';
  const selectionStart = matches[0]!;
  return { selectionStart, selectionEnd: selectionStart + item.text.length };
}

function projectedItem(
  message: StoredMessage,
  item: { kind: 'message' | 'quote'; comment?: string },
  readableContent: string,
): ResolvedMessageSelectionItem {
  return {
    status: 'available',
    kind: item.kind,
    messageId: message.id,
    sourceThreadId: message.threadId,
    author: authorFor(message),
    timestamp: message.timestamp,
    readableContent,
    ...(item.comment ? { comment: item.comment } : {}),
  };
}

export class MessageSelectionResolver {
  constructor(private readonly deps: MessageSelectionResolverDeps) {}

  async resolveForAdmission(input: unknown, auth: MessageSelectionAuth): Promise<MessageSelectionAdmissionResult> {
    const parsed = MessageBundleSelectionSchema.safeParse(input);
    if (!parsed.success) return invalid('invalid_selection');

    const sourceThread = await this.deps.threadStore.get(parsed.data.sourceThreadId);
    if (!canAccessSourceThread(sourceThread, auth)) return invalid('not_authorized');

    const candidates: AdmissionCandidate[] = [];
    for (const item of parsed.data.items) {
      const message = await this.deps.messageStore.getById(item.messageId);
      if (!isSelectableMessage(message, parsed.data.sourceThreadId, auth)) {
        return invalid('source_unavailable', item.messageId);
      }

      if (item.kind === 'message') {
        const readableContent = projectMessageBundleReadableContent(message);
        candidates.push({
          message,
          carrierItem: item,
          projectedItem: projectedItem(message, item, readableContent),
        });
        continue;
      }

      const projection = projectMessageBundleQuoteSourceV1(message);
      const offsets = quoteOffsets(item, projection);
      if (typeof offsets === 'string') return invalid(offsets, item.messageId);

      const carrierItem: MessageBundleItemV1 = {
        kind: 'quote',
        messageId: item.messageId,
        ...offsets,
        sourceProjectionVersion: MESSAGE_BUNDLE_QUOTE_PROJECTION_VERSION,
        sourceProjectionSha256: digestMessageBundleQuoteProjection(projection),
        ...(item.comment ? { comment: item.comment } : {}),
      };
      candidates.push({
        message,
        carrierItem,
        projectedItem: projectedItem(message, item, projection.slice(offsets.selectionStart, offsets.selectionEnd)),
      });
    }

    candidates.sort((left, right) => {
      const timeDelta = getTimelineOrderTime(left.message) - getTimelineOrderTime(right.message);
      return timeDelta || left.message.id.localeCompare(right.message.id);
    });

    const carrier = MessageBundleCarrierV1Schema.parse({
      v: MESSAGE_BUNDLE_VERSION,
      sourceThreadId: parsed.data.sourceThreadId,
      items: candidates.map((candidate) => candidate.carrierItem),
    });
    return {
      status: 'resolved',
      sourceThread: { id: sourceThread.id, title: sourceThread.title },
      carrier,
      items: candidates.map((candidate) => candidate.projectedItem),
    };
  }

  async resolveCarrier(input: unknown, auth: MessageSelectionAuth): Promise<MessageSelectionReadResult> {
    const parsed = MessageBundleCarrierV1Schema.safeParse(input);
    if (!parsed.success) return { status: 'invalid', reason: 'invalid_carrier' };

    const sourceThread = await this.deps.threadStore.get(parsed.data.sourceThreadId);
    if (!canAccessSourceThread(sourceThread, auth)) {
      return {
        status: 'resolved',
        sourceThread: null,
        items: parsed.data.items.map((item) => tombstone(item.messageId, 'source_unavailable')),
      };
    }

    const items: MessageSelectionProjectedItem[] = [];
    for (const item of parsed.data.items) {
      const message = await this.deps.messageStore.getById(item.messageId);
      if (!isSelectableMessage(message, parsed.data.sourceThreadId, auth)) {
        items.push(tombstone(item.messageId, 'source_unavailable'));
        continue;
      }

      if (item.kind === 'message') {
        items.push(projectedItem(message, item, projectMessageBundleReadableContent(message)));
        continue;
      }

      const projection = projectMessageBundleQuoteSourceV1(message);
      const digestMatches =
        item.sourceProjectionVersion === MESSAGE_BUNDLE_QUOTE_PROJECTION_VERSION &&
        digestMessageBundleQuoteProjection(projection) === item.sourceProjectionSha256;
      if (!digestMatches) {
        items.push(tombstone(item.messageId, 'source_changed'));
        continue;
      }
      if (item.selectionEnd > projection.length) {
        items.push(tombstone(item.messageId, 'source_changed'));
        continue;
      }
      items.push(projectedItem(message, item, projection.slice(item.selectionStart, item.selectionEnd)));
    }

    return {
      status: 'resolved',
      sourceThread: { id: sourceThread.id, title: sourceThread.title },
      items,
    };
  }
}
