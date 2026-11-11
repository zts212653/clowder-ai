import {
  MESSAGE_BUNDLE_MAX_ITEMS,
  type MessageBundleSelectionItem,
  projectMarkdownReadableText,
} from '@cat-cafe/shared';
import { projectDomSelectionOffsets } from '@cat-cafe/ui';
import { isWholeMessageSelected, wholeMessageSelection } from '@/components/message-part-selection';
import type { ChatMessage } from '@/stores/chat-types';
import type { ChatUiState } from './types';

export type MessageQuoteSelection = Extract<MessageBundleSelectionItem, { kind: 'quote' }>;

function renderedQuoteOccurrences(row: HTMLElement, text: string) {
  const normalize = (s: string) => s.replace(/\s+/g, ' ').trim();
  const rendered = normalize(row.innerText ?? row.textContent ?? ''),
    needle = normalize(text);
  let count = 0;
  for (let at = rendered.indexOf(needle); at !== -1; at = rendered.indexOf(needle, at + 1)) count++;
  return count;
}

export function messageQuoteSelection(
  message: ChatMessage,
  body: HTMLElement,
  selection: Selection,
): MessageQuoteSelection {
  const text = selection.toString().trim();
  if (
    !text ||
    !selection.rangeCount ||
    !body.contains(selection.anchorNode) ||
    !body.contains(selection.focusNode) ||
    message.extra?.recall ||
    message.isStreaming
  )
    throw new Error('请选择一条已完成消息中的正文');
  const offsets = projectDomSelectionOffsets(
    { kind: 'message', coordinateRoot: body, coordinateRange: selection.getRangeAt(0) },
    selection,
    body,
  );
  return {
    kind: 'quote',
    messageId: message.id,
    text,
    renderedOccurrences: renderedQuoteOccurrences(body.closest<HTMLElement>('[data-mid]')!, text),
    ...(offsets ? { selectionStart: offsets.start, selectionEnd: offsets.end } : {}),
  };
}

export function wholeSelection(message: ChatMessage) {
  const whole = wholeMessageSelection(message);
  return { text: whole.includeText, blocks: Object.fromEntries([...whole.blockIds].map((id) => [id, true])) };
}

export function wholeSelected(message: ChatMessage, selection: ChatUiState['picked'][string]) {
  return isWholeMessageSelected(message, {
    includeText: selection.text,
    blockIds: new Set(Object.keys(selection.blocks)),
  });
}

/** Read the engine's stable message identity only at the export/forward action boundary. */
export function selectedItems(messages: ChatMessage[], picked: ChatUiState['picked']): MessageBundleSelectionItem[] {
  const items = messages
    .filter((m) => picked[m.id] && !m.extra?.recall)
    .flatMap((message): MessageBundleSelectionItem[] => {
      const selection = picked[message.id];
      if (Object.keys(selection.blocks).some((id) => !message.extra?.rich?.blocks.some((b) => b.id === id)))
        throw new Error('请选择仍存在的富块');
      if (wholeSelected(message, selection)) return [{ kind: 'message', messageId: message.id }];
      const parts: MessageBundleSelectionItem[] = [];
      if (selection.text) {
        if (message.contentBlocks?.some((b) => b.type !== 'text'))
          throw new Error('含附件的消息请选择整条，或单独选择富块');
        const text = projectMarkdownReadableText(message.content).trim();
        const row = [...document.querySelectorAll<HTMLElement>('[data-stream] > [data-mid]')].find(
          (el) => el.dataset.mid === message.id,
        );
        if (!row || !text) throw new Error('正文还未加载，请回到消息处重试');
        const renderedOccurrences = renderedQuoteOccurrences(row, text);
        if (renderedOccurrences !== 1) throw new Error('正文与卡片存在重复内容，请选择整条消息或只选卡片');
        parts.push({ kind: 'quote', messageId: message.id, text, renderedOccurrences });
      }
      for (const block of message.extra?.rich?.blocks ?? [])
        if (selection.blocks[block.id])
          parts.push({
            kind: 'rich_block',
            messageId: message.id,
            sourceMessageIds: message.projectionSourceMessageIds ?? [message.id],
            blockId: block.id,
          });
      return parts;
    });
  if (!items.length || items.length > MESSAGE_BUNDLE_MAX_ITEMS)
    throw new Error(`请选择 1–${MESSAGE_BUNDLE_MAX_ITEMS} 项内容`);
  return items;
}

export function cliQuoteSelection(
  message: ChatMessage,
  body: HTMLElement,
  selection: Selection,
  source: import('@cat-cafe/shared').CliOutputQuoteSource,
) {
  if (message.isStreaming || message.extra?.recall || !body.contains(selection.focusNode))
    throw new Error('请选择一条已完成记录中的内容');
  const range = selection.getRangeAt(0),
    before = range.cloneRange();
  before.selectNodeContents(body);
  before.setEnd(range.startContainer, range.startOffset);
  const text = selection.toString().trim(),
    start = before.toString().length + selection.toString().indexOf(text);
  return { kind: 'textsel', mid: message.id, text, source, selectionStart: start, selectionEnd: start + text.length };
}
