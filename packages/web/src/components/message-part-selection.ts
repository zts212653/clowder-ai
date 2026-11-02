import { MESSAGE_BUNDLE_MAX_ITEMS, type MessageBundleSelectionItem } from '@cat-cafe/shared';
import type { ChatMessage, RichBlock } from '@/stores/chat-types';
import { normalizeSelectedMessageIds } from './message-selection';

export interface MessagePartSelection {
  includeText: boolean;
  blockIds: ReadonlySet<string>;
}

export function wholeMessageSelection(message: ChatMessage): MessagePartSelection {
  return {
    includeText: Boolean(message.content.trim() || message.contentBlocks?.length),
    blockIds: new Set(message.extra?.rich?.blocks.map((block) => block.id) ?? []),
  };
}

export function isWholeMessageSelected(message: ChatMessage, selection?: MessagePartSelection): boolean {
  if (!selection) return false;
  const whole = wholeMessageSelection(message);
  return selection.includeText === whole.includeText && [...whole.blockIds].every((id) => selection.blockIds.has(id));
}

export function richBlockSelectionLabel(block: RichBlock, index: number): string {
  if ('title' in block && typeof block.title === 'string' && block.title.trim()) return block.title;
  if (block.kind === 'file') return block.fileName;
  return `卡片 ${index + 1}`;
}

/** Attest the visible body at the action boundary, in the same plane as text selection. */
function readBodyQuote(message: ChatMessage): MessageBundleSelectionItem {
  const row = [...document.querySelectorAll<HTMLElement>('[data-selection-message-id]')].find(
    (element) => element.dataset.selectionMessageId === message.id,
  );
  const bodies = row
    ? [...row.querySelectorAll<HTMLElement>('.markdown-content')].filter(
        (element) =>
          !element.closest(
            '[data-rich-block-id], [data-rich-block-group-id], [data-context-quote-source="cli_output"], [data-quote-exclude]',
          ),
      )
    : [];
  const text = bodies
    .map((body) => body.innerText ?? body.textContent ?? '')
    .join('\n\n')
    .trim();
  if (!row || !text) throw new Error('正文还未加载，请回到消息处重试。');
  if (message.contentBlocks?.some((block) => block.type !== 'text')) {
    throw new Error('这条消息含附件，请勾选整条消息，或只勾需要的卡片。');
  }
  const normalize = (value: string) => value.replace(/\s+/g, ' ').trim();
  const rendered = normalize(row.innerText ?? row.textContent ?? '');
  const needle = normalize(text);
  let renderedOccurrences = 0;
  for (let at = rendered.indexOf(needle); at !== -1; at = rendered.indexOf(needle, at + 1)) renderedOccurrences++;
  if (renderedOccurrences !== 1) throw new Error('正文与卡片有重复内容，请勾选整条消息，或只勾需要的卡片。');
  return { kind: 'quote', messageId: message.id, text, renderedOccurrences };
}

export function selectedMessageParts(
  messages: readonly ChatMessage[],
  selections: ReadonlyMap<string, MessagePartSelection>,
): MessageBundleSelectionItem[] {
  const byId = new Map(messages.map((message) => [message.id, message]));
  const items = normalizeSelectedMessageIds(messages, new Set(selections.keys())).flatMap((messageId) => {
    const message = byId.get(messageId)!;
    const selection = selections.get(messageId)!;
    if (isWholeMessageSelected(message, selection))
      return [{ kind: 'message', messageId } as MessageBundleSelectionItem];
    const parts: MessageBundleSelectionItem[] = selection.includeText ? [readBodyQuote(message)] : [];
    for (const block of message.extra?.rich?.blocks ?? []) {
      if (selection.blockIds.has(block.id))
        parts.push({
          kind: 'rich_block',
          messageId,
          sourceMessageIds: message.projectionSourceMessageIds ?? [messageId],
          blockId: block.id,
        });
    }
    return parts;
  });
  if (items.length > MESSAGE_BUNDLE_MAX_ITEMS)
    throw new Error(`所选内容超过 ${MESSAGE_BUNDLE_MAX_ITEMS} 项，请减少消息或卡片。`);
  return items;
}

export function partialSelectionSummary(
  messages: readonly ChatMessage[],
  selections: ReadonlyMap<string, MessagePartSelection>,
) {
  let unselectedCardCount = 0;
  const details: string[] = [];
  const ids = normalizeSelectedMessageIds(messages, new Set(selections.keys()));
  for (const [index, id] of ids.entries()) {
    const message = messages.find((candidate) => candidate.id === id)!;
    const selection = selections.get(id)!;
    if (isWholeMessageSelected(message, selection)) continue;
    const included: string[] = selection.includeText ? ['文字'] : [];
    const excluded: string[] = [];
    for (const [blockIndex, block] of (message.extra?.rich?.blocks ?? []).entries()) {
      const label = `「${richBlockSelectionLabel(block, blockIndex)}」`;
      if (selection.blockIds.has(block.id)) included.push(label);
      else {
        excluded.push(label);
        unselectedCardCount++;
      }
    }
    details.push(
      `第 ${index + 1} 条：只带${included.join('、')}${excluded.length ? `；没带${excluded.join('、')}` : ''}`,
    );
  }
  return { unselectedCardCount, selectionSummary: details.join('。') };
}
