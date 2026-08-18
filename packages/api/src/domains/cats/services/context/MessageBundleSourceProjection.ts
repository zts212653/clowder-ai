import { createHash } from 'node:crypto';
import {
  cleanCliToolLabel,
  MESSAGE_BUNDLE_CLI_QUOTE_DIGEST_DOMAIN,
  MESSAGE_BUNDLE_QUOTE_DIGEST_DOMAIN,
  MESSAGE_BUNDLE_RICH_BLOCK_DIGEST_DOMAIN,
  type MessageContent,
  projectCliToolUseLabel,
  type RichBlock,
} from '@cat-cafe/shared';
import type { StoredMessage, StoredToolEvent } from '../stores/ports/MessageStore.js';
import type { Thread } from '../stores/ports/ThreadStore.js';
import { canViewMessage, isTimelinePublished } from '../stores/visibility.js';
import type { MessageSelectionAuth } from './message-selection-types.js';

export function digestMessageBundleQuoteProjection(projection: string): string {
  return createHash('sha256')
    .update(MESSAGE_BUNDLE_QUOTE_DIGEST_DOMAIN, 'utf8')
    .update(projection, 'utf8')
    .digest('hex');
}

export function digestMessageBundleCliQuoteProjection(projection: string): string {
  return createHash('sha256')
    .update(MESSAGE_BUNDLE_CLI_QUOTE_DIGEST_DOMAIN, 'utf8')
    .update(projection, 'utf8')
    .digest('hex');
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Rich Block digest rejects non-finite numbers');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(',')}}`;
  }
  throw new TypeError(`Rich Block digest rejects ${typeof value}`);
}

export function digestMessageBundleRichBlockProjection(block: RichBlock): string {
  return createHash('sha256')
    .update(MESSAGE_BUNDLE_RICH_BLOCK_DIGEST_DOMAIN, 'utf8')
    .update(canonicalJson(block), 'utf8')
    .digest('hex');
}

interface ProjectedCliTool {
  id: string;
  label: string;
  detail?: string;
}

interface ProjectedCliToolState {
  uses: ProjectedCliTool[];
  results: Array<{ detail?: string }>;
  skipNextResult: boolean;
}

function appendProjectedCliTool(event: StoredToolEvent, state: ProjectedCliToolState): void {
  if (event.type === 'tool_use') {
    const toolName = cleanCliToolLabel(event.label);
    state.skipNextResult = toolName === 'unknown';
    if (state.skipNextResult) return;
    state.uses.push({
      id: event.id,
      label: projectCliToolUseLabel(event.label, event.detail),
      ...(event.detail ? { detail: event.detail } : {}),
    });
    return;
  }
  if (state.skipNextResult) {
    state.skipNextResult = false;
    return;
  }
  state.results.push(event.detail ? { detail: event.detail } : {});
}

function projectCliTools(records: readonly StoredMessage[]): ProjectedCliTool[] {
  const state: ProjectedCliToolState = { uses: [], results: [], skipNextResult: false };
  for (const record of records) {
    for (const event of record.toolEvents ?? []) {
      appendProjectedCliTool(event, state);
    }
  }
  return state.uses.map((use, index) => ({
    ...use,
    ...(state.results[index]?.detail ? { detail: state.results[index].detail } : {}),
  }));
}

export function projectCliSegment(records: readonly StoredMessage[], segmentId: string): string | null {
  if (segmentId === 'stdout') {
    const hasCallback = records.some((record) => record.origin === 'callback');
    const parts = records
      .filter((record) => !hasCallback || record.origin !== 'callback')
      .map((record) => record.content)
      .filter((content) => content.trim().length > 0);
    return parts.length > 0 ? parts.join('\n\n') : null;
  }
  const separator = segmentId.indexOf(':');
  if (separator <= 0) return null;
  const kind = segmentId.slice(0, separator);
  const eventId = segmentId.slice(separator + 1);
  const tool = projectCliTools(records).find((candidate) => candidate.id === eventId);
  if (!tool) return null;
  if (kind === 'tool-label') return tool.label;
  if (kind === 'tool-detail') return tool.detail?.length ? tool.detail : null;
  return null;
}

export function sanitizeRichBlock(block: RichBlock): RichBlock {
  if (block.kind === 'card') {
    const { actions: _actions, meta: _meta, ...passive } = block;
    return structuredClone(passive);
  }
  if (block.kind === 'interactive') {
    return {
      id: block.id,
      kind: 'card',
      v: 1,
      title: block.title?.trim() || '交互选项（只读）',
      ...(block.description?.trim() ? { bodyMarkdown: block.description.trim() } : {}),
      fields: block.options.map((option) => ({ label: option.label, value: option.description?.trim() || '选项' })),
    };
  }
  if (block.kind === 'html_widget') {
    return {
      id: block.id,
      kind: 'card',
      v: 1,
      title: block.title?.trim() || '交互内容（只读）',
      bodyMarkdown: '原交互内容未在转发卡中执行。',
    };
  }
  return structuredClone(block);
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

function readCardFallback(block: Extract<RichBlock, { kind: 'card' }>): string {
  const lines = [`[卡片: ${block.title}]`];
  if (block.bodyMarkdown?.trim()) lines.push(block.bodyMarkdown.trim());
  for (const field of block.fields ?? []) lines.push(`${field.label}: ${field.value}`);
  return lines.join('\n');
}

function readChecklistFallback(block: Extract<RichBlock, { kind: 'checklist' }>): string {
  const lines = [`[清单${block.title?.trim() ? `: ${block.title.trim()}` : ''}]`];
  lines.push(...block.items.map((item) => `${item.checked ? '[x]' : '[ ]'} ${item.text}`));
  return lines.join('\n');
}

function readMediaGalleryFallback(block: Extract<RichBlock, { kind: 'media_gallery' }>): string {
  const lines = [`[图片集${block.title?.trim() ? `: ${block.title.trim()}` : ''}]`];
  lines.push(...block.items.map((item) => item.caption?.trim() || item.alt?.trim() || '[图片]'));
  return lines.join('\n');
}

function readInteractiveFallback(block: Extract<RichBlock, { kind: 'interactive' }>): string {
  const lines = [`[交互选项${block.title?.trim() ? `: ${block.title.trim()}` : ''}]`];
  if (block.description?.trim()) lines.push(block.description.trim());
  lines.push(...block.options.map((option) => `- ${option.label}`));
  return lines.join('\n');
}

export function readRichBlockFallback(block: RichBlock): string {
  switch (block.kind) {
    case 'card':
      return readCardFallback(block);
    case 'diff':
      return `[Diff: ${block.filePath}]\n${block.diff}`;
    case 'checklist':
      return readChecklistFallback(block);
    case 'media_gallery':
      return readMediaGalleryFallback(block);
    case 'audio': {
      const label = `[音频${block.title?.trim() ? `: ${block.title.trim()}` : ''}]`;
      return block.text?.trim() ? `${label}\n${block.text.trim()}` : label;
    }
    case 'interactive':
      return readInteractiveFallback(block);
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

export function canAccessSourceThread(thread: Thread | null, auth: MessageSelectionAuth): thread is Thread {
  return Boolean(thread && !thread.deletedAt && (thread.createdBy === auth.userId || thread.createdBy === 'system'));
}

export function isAccessibleSourceRecord(
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
      canViewMessage(message, { type: 'user' }),
  );
}

export function isSourceGroupTerminal(records: readonly StoredMessage[]): boolean {
  if (records.some((record) => record.origin === 'callback')) return true;
  for (let index = records.length - 1; index >= 0; index--) {
    const isStreaming = (records[index] as StoredMessage & { isStreaming?: boolean }).isStreaming;
    if (typeof isStreaming === 'boolean') return !isStreaming;
  }
  return true;
}

export function isSelectableMessage(
  message: StoredMessage | null,
  sourceThreadId: string,
  auth: MessageSelectionAuth,
): message is StoredMessage {
  return Boolean(
    isAccessibleSourceRecord(message, sourceThreadId, auth) &&
      isSourceGroupTerminal([message]) &&
      projectMessageBundleReadableContent(message).trim().length > 0,
  );
}

export function sortSourceRecords(records: StoredMessage[]): StoredMessage[] {
  return records.sort((left, right) => {
    // Mirror packages/web/src/stores/bubble-projection.ts compareRecords.
    const timeDelta = left.timestamp - right.timestamp;
    return timeDelta || left.id.localeCompare(right.id);
  });
}

export function richBlockFromRecords(records: readonly StoredMessage[], blockId: string): RichBlock | null {
  for (const record of records) {
    const block = record.extra?.rich?.blocks.find((candidate) => candidate.id === blockId);
    if (block) return block;
  }
  return null;
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

export function quoteOffsets(
  item: { text: string; selectionStart?: number; selectionEnd?: number },
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
  const selectionStart = matches[0];
  if (selectionStart === undefined) return 'quote_mismatch';
  return { selectionStart, selectionEnd: selectionStart + item.text.length };
}
