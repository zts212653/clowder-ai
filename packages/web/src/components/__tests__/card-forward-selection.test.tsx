import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ChatMessage } from '@/stores/chat-types';
import { MessageActions } from '../MessageActions';
import { RichBlocks } from '../rich/RichBlocks';
import { useThreadChatSelection } from '../thread-chat/useThreadChatSelection';

vi.mock('@/hooks/useTextSelectionAction', () => ({ useTextSelectionAction: () => null }));
vi.mock('../useMessageAnnotationMarkers', () => ({ useMessageAnnotationMarkers: () => [] }));

const messages: ChatMessage[] = [
  {
    id: 'source',
    type: 'assistant',
    catId: 'codex61-sol',
    timestamp: 1,
    content: '两件都弄好了：',
    extra: {
      rich: {
        v: 1,
        blocks: [
          { id: 'result', kind: 'card', v: 1, title: '审批卡统一结果行', bodyMarkdown: '#5963 · 已合入' },
          { id: 'quota', kind: 'card', v: 1, title: '额度表 · 本周', bodyMarkdown: '3 个号' },
        ],
      },
    },
  },
  { id: 'plain', type: 'user', timestamp: 2, content: '这周先按这版走。' },
];
let selection: ReturnType<typeof useThreadChatSelection>;
function Harness() {
  selection = useThreadChatSelection(messages);
  return (
    <>
      {messages.map((message) => (
        <MessageActions
          key={message.id}
          message={message}
          threadId="test"
          selectionEligible
          selectionMode={selection.selectionMode}
          selected={selection.selectedMessageIds.has(message.id)}
          partiallySelected={selection.isPartiallySelected(message.id)}
          partSelection={selection.partSelections.get(message.id)}
          onToggleRichBlock={selection.toggleRichBlockSelection}
          onToggleSelection={selection.toggleMessageSelection}
          onEnterSelection={selection.enterMessageSelection}
        >
          <div data-message-id={message.id}>
            <div className="markdown-content">{message.content}</div>
            <RichBlocks blocks={message.extra?.rich?.blocks ?? []} messageId={message.id} sourceThreadId="test" />
          </div>
        </MessageActions>
      ))}
    </>
  );
}
let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  React.act(() => root.unmount());
  container.remove();
});

it('keeps text when a card is unchecked and shares the exact partial basket with every exit', () => {
  React.act(() => root.render(<Harness />));
  expect(container.querySelector('[data-testid="rich-block-forward-actions"]')).toBeNull();
  React.act(() => selection.enterMessageSelection('source'));
  const card = container.querySelector<HTMLButtonElement>('[data-rich-block-id="quota"] [role="checkbox"]');
  expect(card).not.toBeNull();
  React.act(() => card?.click());
  expect(
    container.querySelector(
      '[data-selection-message-id="source"] > * [aria-checked="mixed"], [data-selection-message-id="source"] > [aria-checked="mixed"]',
    ),
  ).not.toBeNull();
  expect(selection.unselectedCardCount).toBe(1);
  expect(selection.getSelectedBundleItems()).toEqual([
    { kind: 'quote', messageId: 'source', text: '两件都弄好了：', renderedOccurrences: 1 },
    { kind: 'rich_block', messageId: 'source', sourceMessageIds: ['source'], blockId: 'result' },
  ]);
  React.act(() => selection.toggleMessageSelection('plain'));
  expect(selection.getSelectedBundleItems().at(-1)).toEqual({ kind: 'message', messageId: 'plain' });
  React.act(() => selection.toggleMessageSelection('source'));
  expect(selection.getSelectedBundleItems()).toEqual([
    { kind: 'message', messageId: 'source' },
    { kind: 'message', messageId: 'plain' },
  ]);
});

it('can select only one card without its text, then clear and reenter with no stale card choices', () => {
  React.act(() => root.render(<Harness />));
  React.act(() => selection.enterMessageSelection('plain'));
  React.act(() => selection.toggleRichBlockSelection('source', 'quota'));
  expect(selection.getSelectedBundleItems()).toEqual([
    { kind: 'rich_block', messageId: 'source', sourceMessageIds: ['source'], blockId: 'quota' },
    { kind: 'message', messageId: 'plain' },
  ]);
  expect(selection.isPartiallySelected('source')).toBe(true);
  React.act(() => selection.clearMessageSelection());
  React.act(() => selection.enterMessageSelection('source'));
  expect(selection.getSelectedBundleItems()).toEqual([{ kind: 'message', messageId: 'source' }]);
});

it('keeps a grouped form and its pending choices mounted while card selection appears', () => {
  const grouped: ChatMessage = {
    ...messages[0]!,
    id: 'grouped',
    extra: {
      rich: {
        v: 1,
        blocks: [
          {
            id: 'choice-a',
            kind: 'interactive',
            v: 1,
            interactiveType: 'select',
            groupId: 'same-form',
            title: 'First choice',
            options: [{ id: 'a', label: 'Answer A' }],
          },
          {
            id: 'choice-b',
            kind: 'interactive',
            v: 1,
            interactiveType: 'select',
            groupId: 'same-form',
            title: 'Second choice',
            options: [{ id: 'b', label: 'Answer B' }],
          },
        ],
      },
    },
  };
  const render = (selectionMode: boolean) =>
    React.act(() =>
      root.render(
        <MessageActions
          message={grouped}
          threadId="test"
          selectionEligible
          selectionMode={selectionMode}
          selected
          partSelection={{ includeText: true, blockIds: new Set(['choice-a', 'choice-b']) }}
          onToggleRichBlock={vi.fn()}
        >
          <RichBlocks blocks={grouped.extra!.rich!.blocks} messageId="grouped" />
        </MessageActions>,
      ),
    );
  const button = (text: string) =>
    [...container.querySelectorAll('button')].find((node) => node.textContent?.includes(text))!;
  render(false);
  React.act(() => {
    button('Answer A').click();
    button('Answer B').click();
  });
  const submit = button('全部提交');
  expect(submit.disabled).toBe(false);
  render(true);
  expect(container.querySelectorAll('[data-rich-block-id] [role="checkbox"]')).toHaveLength(2);
  expect(button('全部提交')).toBe(submit);
  expect(submit.disabled).toBe(false);
  render(false);
  expect(button('全部提交')).toBe(submit);
  expect(submit.disabled).toBe(false);
});
