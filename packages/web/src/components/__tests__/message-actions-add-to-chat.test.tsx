import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { MessageActions } from '@/components/MessageActions';
import { useChatStore } from '@/stores/chatStore';

function mockSelection(node: Node, text: string, rect: () => DOMRect) {
  const selection = {
    isCollapsed: false,
    anchorNode: node,
    focusNode: node,
    toString: () => text,
    rangeCount: 1,
    getRangeAt: () => ({
      getClientRects: () => [rect()],
      getBoundingClientRect: rect,
      commonAncestorContainer: node,
    }),
    removeAllRanges: vi.fn(),
  } as unknown as Selection;
  vi.spyOn(window, 'getSelection').mockReturnValue(selection);
  document.dispatchEvent(new Event('selectionchange'));
}

function mockMixedSelection(anchorNode: Node, focusNode: Node, commonAncestorContainer: Node, rect: () => DOMRect) {
  const selection = {
    isCollapsed: false,
    anchorNode,
    focusNode,
    toString: () => 'message text and command output',
    rangeCount: 1,
    getRangeAt: () => ({
      getClientRects: () => [rect()],
      getBoundingClientRect: rect,
      commonAncestorContainer,
    }),
    removeAllRanges: vi.fn(),
  } as unknown as Selection;
  vi.spyOn(window, 'getSelection').mockReturnValue(selection);
  document.dispatchEvent(new Event('selectionchange'));
}

function mockSelectionAcrossNestedSource(
  anchorNode: Node,
  focusNode: Node,
  commonAncestorContainer: Node,
  nestedSource: Element,
  rect: () => DOMRect,
) {
  const selection = {
    isCollapsed: false,
    anchorNode,
    focusNode,
    toString: () => 'before command output after',
    rangeCount: 1,
    getRangeAt: () => ({
      getClientRects: () => [rect()],
      getBoundingClientRect: rect,
      commonAncestorContainer,
      intersectsNode: (node: Node) => node === nestedSource,
    }),
    removeAllRanges: vi.fn(),
  } as unknown as Selection;
  vi.spyOn(window, 'getSelection').mockReturnValue(selection);
  document.dispatchEvent(new Event('selectionchange'));
}

describe('MessageActions Add to chat selection', () => {
  let container: HTMLDivElement;
  let root: Root;
  let top: number;

  beforeAll(() => {
    (globalThis as { React?: typeof React }).React = React;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    top = 120;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    useChatStore.setState({ currentThreadId: 'thread-1', pendingChatInsert: null });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  afterAll(() => {
    delete (globalThis as { React?: typeof React }).React;
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  function renderMessage(child: React.ReactNode) {
    act(() => {
      root.render(
        <MessageActions
          message={{ id: 'msg-1', type: 'assistant', catId: 'opus', content: 'body', timestamp: 1 }}
          threadId="thread-1"
        >
          {child}
        </MessageActions>,
      );
    });
  }

  const rect = () => ({ top, right: 260, bottom: top + 20, left: 120, width: 140, height: 20 }) as DOMRect;

  it('creates a sourced Message quote and follows nested scroll geometry', () => {
    renderMessage(<span data-testid="message-text">selected message text</span>);
    const textNode = container.querySelector('[data-testid="message-text"]')?.firstChild;
    if (!textNode) throw new Error('message text missing');

    act(() => mockSelection(textNode, 'selected message text', rect));
    const action = container.querySelector<HTMLButtonElement>('[data-testid="message-selection-add-to-chat"]');
    expect(action).not.toBeNull();
    const initialTop = action?.style.top;

    top = 220;
    act(() => document.dispatchEvent(new Event('scroll')));
    expect(action?.style.top).not.toBe(initialTop);

    act(() => action?.click());
    expect(useChatStore.getState().pendingChatInsert).toEqual({
      threadId: 'thread-1',
      text: '',
      contextAttachments: [
        expect.objectContaining({
          kind: 'quote',
          text: 'selected message text',
          source: { kind: 'message', threadId: 'thread-1', messageId: 'msg-1', senderCatId: 'opus' },
        }),
      ],
    });
  });

  it('uses CLI Output source identity when the selected node is inside its marked body', () => {
    renderMessage(
      <div data-context-quote-source="cli_output">
        <span data-testid="cli-text">command output</span>
      </div>,
    );
    const textNode = container.querySelector('[data-testid="cli-text"]')?.firstChild;
    if (!textNode) throw new Error('CLI text missing');

    act(() => mockSelection(textNode, 'command output', rect));
    act(() => container.querySelector<HTMLButtonElement>('[data-testid="message-selection-add-to-chat"]')?.click());

    expect(useChatStore.getState().pendingChatInsert?.contextAttachments?.[0]).toMatchObject({
      kind: 'quote',
      text: 'command output',
      source: { kind: 'cli_output', threadId: 'thread-1', messageId: 'msg-1' },
    });
  });

  it('rejects a selection that mixes normal message text with nested CLI Output', () => {
    renderMessage(
      <div data-testid="mixed-message">
        <span data-testid="message-text">message text</span>
        <div data-context-quote-source="cli_output">
          <span data-testid="cli-text">command output</span>
        </div>
      </div>,
    );
    const anchorNode = container.querySelector('[data-testid="message-text"]')?.firstChild;
    const focusNode = container.querySelector('[data-testid="cli-text"]')?.firstChild;
    const commonAncestor = container.querySelector('[data-testid="mixed-message"]');
    if (!anchorNode || !focusNode || !commonAncestor) throw new Error('mixed selection fixtures missing');

    act(() => mockMixedSelection(anchorNode, focusNode, commonAncestor, rect));

    expect(container.querySelector('[data-testid="message-selection-add-to-chat"]')).toBeNull();
    expect(useChatStore.getState().pendingChatInsert).toBeNull();
  });

  it('rejects an outer-message selection whose endpoints surround a nested CLI Output', () => {
    renderMessage(
      <div data-testid="spanning-message">
        <span data-testid="before-text">before</span>
        <div data-context-quote-source="cli_output" data-testid="nested-cli">
          command output
        </div>
        <span data-testid="after-text">after</span>
      </div>,
    );
    const anchorNode = container.querySelector('[data-testid="before-text"]')?.firstChild;
    const focusNode = container.querySelector('[data-testid="after-text"]')?.firstChild;
    const commonAncestor = container.querySelector('[data-testid="spanning-message"]');
    const nestedSource = container.querySelector('[data-testid="nested-cli"]');
    if (!anchorNode || !focusNode || !commonAncestor || !nestedSource) {
      throw new Error('spanning selection fixtures missing');
    }

    act(() => mockSelectionAcrossNestedSource(anchorNode, focusNode, commonAncestor, nestedSource, rect));

    expect(container.querySelector('[data-testid="message-selection-add-to-chat"]')).toBeNull();
    expect(useChatStore.getState().pendingChatInsert).toBeNull();
  });

  it('hides the action when nested scrolling moves every selection fragment out of view', () => {
    renderMessage(<span data-testid="message-text">selected message text</span>);
    const textNode = container.querySelector('[data-testid="message-text"]')?.firstChild;
    if (!textNode) throw new Error('message text missing');

    act(() => mockSelection(textNode, 'selected message text', rect));
    expect(container.querySelector('[data-testid="message-selection-add-to-chat"]')).not.toBeNull();

    top = window.innerHeight + 100;
    act(() => document.dispatchEvent(new Event('scroll')));
    expect(container.querySelector('[data-testid="message-selection-add-to-chat"]')).toBeNull();
  });
});
