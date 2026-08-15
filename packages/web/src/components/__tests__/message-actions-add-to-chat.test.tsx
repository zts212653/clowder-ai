import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { MessageActions } from '@/components/MessageActions';
import { syncContextAttachmentDraftToStorage } from '@/components/thread-drafts';
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

function collapseDocumentSelection() {
  vi.spyOn(window, 'getSelection').mockReturnValue({
    isCollapsed: true,
    anchorNode: null,
    focusNode: null,
    toString: () => '',
    rangeCount: 0,
    removeAllRanges: vi.fn(),
  } as unknown as Selection);
  document.dispatchEvent(new Event('selectionchange'));
}

function setTextareaValue(textarea: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
  setter?.call(textarea, value);
  textarea.dispatchEvent(new Event('input', { bubbles: true }));
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
  let originalRangeBoundingRect: PropertyDescriptor | undefined;

  beforeAll(() => {
    (globalThis as { React?: typeof React }).React = React;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    originalRangeBoundingRect = Object.getOwnPropertyDescriptor(Range.prototype, 'getBoundingClientRect');
  });

  beforeEach(() => {
    top = 120;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    useChatStore.setState({ currentThreadId: 'thread-1', pendingChatInsert: null });
    syncContextAttachmentDraftToStorage('thread-1', []);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    if (originalRangeBoundingRect) {
      Object.defineProperty(Range.prototype, 'getBoundingClientRect', originalRangeBoundingRect);
    } else {
      Reflect.deleteProperty(Range.prototype, 'getBoundingClientRect');
    }
    syncContextAttachmentDraftToStorage('thread-1', []);
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

  it('pairs a selected Message quote with its comment before adding it to the composer', () => {
    renderMessage(<span data-testid="message-text">selected message text</span>);
    const textNode = container.querySelector('[data-testid="message-text"]')?.firstChild;
    if (!textNode) throw new Error('message text missing');

    act(() => mockSelection(textNode, 'selected message text', rect));
    const action = document.body.querySelector<HTMLButtonElement>('[data-testid="message-selection-add-to-chat"]');
    expect(action).not.toBeNull();
    const initialTop = action?.style.top;

    top = 220;
    act(() => document.dispatchEvent(new Event('scroll')));
    expect(action?.style.top).not.toBe(initialTop);

    act(() => action?.click());
    expect(useChatStore.getState().pendingChatInsert).toBeNull();

    const comment = document.body.querySelector<HTMLTextAreaElement>('[data-testid="context-annotation-comment"]');
    expect(document.activeElement).toBe(comment);
    act(() => {
      if (!comment) throw new Error('annotation comment editor missing');
      setTextareaValue(comment, 'comment for selected message text');
    });
    act(() => document.body.querySelector<HTMLButtonElement>('[data-testid="context-annotation-save"]')?.click());

    expect(useChatStore.getState().pendingChatInsert).toEqual({
      threadId: 'thread-1',
      text: '',
      contextAttachments: [
        expect.objectContaining({
          kind: 'quote',
          text: 'selected message text',
          comment: 'comment for selected message text',
          source: { kind: 'message', threadId: 'thread-1', messageId: 'msg-1', senderCatId: 'opus' },
        }),
      ],
    });
  });

  it('keeps the clicked Message quote editor after textarea focus collapses the live document selection', () => {
    renderMessage(<span data-testid="message-text">snapshot-selected message text</span>);
    const textNode = container.querySelector('[data-testid="message-text"]')?.firstChild;
    if (!textNode) throw new Error('message text missing');

    act(() => mockSelection(textNode, 'snapshot-selected message text', rect));
    act(() => document.body.querySelector<HTMLButtonElement>('[data-testid="message-selection-add-to-chat"]')?.click());
    act(() => collapseDocumentSelection());

    const editor = document.body.querySelector<HTMLElement>('[data-testid="context-annotation-editor"]');
    expect(editor?.textContent).toContain('snapshot-selected message text');
    const comment = document.body.querySelector<HTMLTextAreaElement>('[data-testid="context-annotation-comment"]');
    act(() => {
      if (!comment) throw new Error('annotation comment editor missing after selection collapse');
      setTextareaValue(comment, 'comment survives Chromium focus');
    });
    act(() => document.body.querySelector<HTMLButtonElement>('[data-testid="context-annotation-save"]')?.click());

    expect(useChatStore.getState().pendingChatInsert?.contextAttachments?.[0]).toMatchObject({
      kind: 'quote',
      text: 'snapshot-selected message text',
      comment: 'comment survives Chromium focus',
      source: { kind: 'message', threadId: 'thread-1', messageId: 'msg-1', senderCatId: 'opus' },
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
    act(() => document.body.querySelector<HTMLButtonElement>('[data-testid="message-selection-add-to-chat"]')?.click());
    act(() => collapseDocumentSelection());
    const comment = document.body.querySelector<HTMLTextAreaElement>('[data-testid="context-annotation-comment"]');
    act(() => {
      if (!comment) throw new Error('annotation comment editor missing');
      setTextareaValue(comment, 'CLI comment');
    });
    act(() => document.body.querySelector<HTMLButtonElement>('[data-testid="context-annotation-save"]')?.click());

    expect(useChatStore.getState().pendingChatInsert?.contextAttachments?.[0]).toMatchObject({
      kind: 'quote',
      text: 'command output',
      comment: 'CLI comment',
      source: { kind: 'cli_output', threadId: 'thread-1', messageId: 'msg-1' },
    });
  });

  it('measures CLI Output offsets from the nested CLI source instead of preceding message siblings', () => {
    renderMessage(
      <>
        <div data-testid="thinking-text">thinking before the command</div>
        <div data-context-quote-source="cli_output">
          <span data-context-quote-segment-id="stdout" data-testid="cli-local-text">
            target output
          </span>
        </div>
      </>,
    );
    const textNode = container.querySelector('[data-testid="cli-local-text"]')?.firstChild;
    if (!textNode) throw new Error('CLI text missing');
    const range = document.createRange();
    range.setStart(textNode, 0);
    range.setEnd(textNode, 6);
    Object.defineProperties(range, {
      getClientRects: { value: () => [rect()] },
      getBoundingClientRect: { value: rect },
    });
    vi.spyOn(window, 'getSelection').mockReturnValue({
      isCollapsed: false,
      anchorNode: textNode,
      focusNode: textNode,
      toString: () => 'target',
      rangeCount: 1,
      getRangeAt: () => range,
      removeAllRanges: vi.fn(),
    } as unknown as Selection);

    act(() => document.dispatchEvent(new Event('selectionchange')));
    act(() => document.body.querySelector<HTMLButtonElement>('[data-testid="message-selection-add-to-chat"]')?.click());
    const comment = document.body.querySelector<HTMLTextAreaElement>('[data-testid="context-annotation-comment"]');
    act(() => {
      if (!comment) throw new Error('annotation comment editor missing');
      setTextareaValue(comment, 'source-local CLI comment');
    });
    act(() => document.body.querySelector<HTMLButtonElement>('[data-testid="context-annotation-save"]')?.click());

    expect(useChatStore.getState().pendingChatInsert?.contextAttachments?.[0]).toMatchObject({
      text: 'target',
      selectionStart: 0,
      selectionEnd: 6,
      source: { kind: 'cli_output', threadId: 'thread-1', messageId: 'msg-1', segmentId: 'stdout' },
    });
  });

  it('cancels an annotation without mutating or sending the composer draft', () => {
    renderMessage(<span data-testid="message-text">selected message text</span>);
    const textNode = container.querySelector('[data-testid="message-text"]')?.firstChild;
    if (!textNode) throw new Error('message text missing');
    act(() => mockSelection(textNode, 'selected message text', rect));
    act(() => document.body.querySelector<HTMLButtonElement>('[data-testid="message-selection-add-to-chat"]')?.click());
    const cancel = [...document.body.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent === 'Cancel',
    );
    act(() => cancel?.click());

    expect(document.body.querySelector('[data-testid="context-annotation-editor"]')).toBeNull();
    expect(useChatStore.getState().pendingChatInsert).toBeNull();
  });

  it('persists source-relative offsets so numbered markers can be reconstructed', () => {
    renderMessage(<span data-testid="message-text">prefix selected suffix</span>);
    const textNode = container.querySelector('[data-testid="message-text"]')?.firstChild;
    if (!textNode) throw new Error('message text missing');
    const range = document.createRange();
    range.setStart(textNode, 7);
    range.setEnd(textNode, 15);
    Object.defineProperties(range, {
      getClientRects: { value: () => [rect()] },
      getBoundingClientRect: { value: rect },
    });
    const selection = {
      isCollapsed: false,
      anchorNode: textNode,
      focusNode: textNode,
      toString: () => 'selected',
      rangeCount: 1,
      getRangeAt: () => range,
      removeAllRanges: vi.fn(),
    } as unknown as Selection;
    vi.spyOn(window, 'getSelection').mockReturnValue(selection);
    act(() => document.dispatchEvent(new Event('selectionchange')));
    act(() => document.body.querySelector<HTMLButtonElement>('[data-testid="message-selection-add-to-chat"]')?.click());
    const comment = document.body.querySelector<HTMLTextAreaElement>('[data-testid="context-annotation-comment"]');
    act(() => {
      if (!comment) throw new Error('annotation comment editor missing');
      setTextareaValue(comment, 'offset comment');
    });
    act(() => document.body.querySelector<HTMLButtonElement>('[data-testid="context-annotation-save"]')?.click());

    expect(useChatStore.getState().pendingChatInsert?.contextAttachments?.[0]).toMatchObject({
      text: 'selected',
      comment: 'offset comment',
      selectionStart: 7,
      selectionEnd: 15,
    });
  });

  it('reconstructs a numbered marker from the composer draft and edits the same annotation', () => {
    const boundingRect = vi.fn(() => rect());
    Object.defineProperty(Range.prototype, 'getBoundingClientRect', {
      configurable: true,
      value: boundingRect,
    });
    syncContextAttachmentDraftToStorage('thread-1', [
      {
        v: 1,
        id: 'ctx-thread-before-markers',
        kind: 'thread',
        threadId: 'thread-source',
        title: 'Source thread',
      },
      {
        v: 1,
        id: 'ctx-quote-first-marker',
        kind: 'quote',
        text: 'selected',
        comment: 'first comment',
        selectionStart: 0,
        selectionEnd: 8,
        source: { kind: 'message', threadId: 'thread-1', messageId: 'msg-1', senderCatId: 'opus' },
      },
      {
        v: 1,
        id: 'ctx-quote-marker',
        kind: 'quote',
        text: 'message',
        comment: 'original comment',
        selectionStart: 9,
        selectionEnd: 16,
        source: { kind: 'message', threadId: 'thread-1', messageId: 'msg-1', senderCatId: 'opus' },
      },
    ]);

    renderMessage(<span data-testid="message-text">selected message text</span>);
    expect(
      document.body.querySelector<HTMLButtonElement>('[data-testid="context-annotation-marker-ctx-quote-first-marker"]')
        ?.textContent,
    ).toBe('1');
    const marker = document.body.querySelector<HTMLButtonElement>(
      '[data-testid="context-annotation-marker-ctx-quote-marker"]',
    );
    expect(marker?.textContent).toBe('2');

    act(() => marker?.click());
    let comment = document.body.querySelector<HTMLTextAreaElement>('[data-testid="context-annotation-comment"]');
    expect(comment?.value).toBe('original comment');
    act(() => comment?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    const restoredMarker = document.body.querySelector<HTMLButtonElement>(
      '[data-testid="context-annotation-marker-ctx-quote-marker"]',
    );
    act(() => restoredMarker?.click());
    comment = document.body.querySelector<HTMLTextAreaElement>('[data-testid="context-annotation-comment"]');
    expect(comment?.value).toBe('original comment');
    act(() => {
      if (!comment) throw new Error('annotation comment editor missing');
      setTextareaValue(comment, 'updated comment');
    });
    act(() => document.body.querySelector<HTMLButtonElement>('[data-testid="context-annotation-save"]')?.click());

    expect(useChatStore.getState().pendingChatInsert).toMatchObject({
      threadId: 'thread-1',
      removeContextAttachmentIds: ['ctx-quote-marker'],
      contextAttachments: [expect.objectContaining({ id: 'ctx-quote-marker', comment: 'updated comment' })],
    });
  });

  it('projects a drafted CLI marker only from its source root and recomputes after disclosure layout commits', () => {
    Object.defineProperty(Range.prototype, 'getBoundingClientRect', {
      configurable: true,
      value: () => rect(),
    });
    syncContextAttachmentDraftToStorage('thread-1', [
      {
        v: 1,
        id: 'ctx-quote-collapsed-cli',
        kind: 'quote',
        text: 'target',
        comment: 'CLI marker comment',
        selectionStart: 0,
        selectionEnd: 6,
        source: { kind: 'cli_output', threadId: 'thread-1', messageId: 'msg-1', segmentId: 'stdout' },
      },
    ]);

    renderMessage(<div data-testid="expanded-thinking">thinking content before CLI</div>);
    expect(document.body.querySelector('[data-testid="context-annotation-marker-ctx-quote-collapsed-cli"]')).toBeNull();

    act(() => {
      root.render(
        <MessageActions
          message={{ id: 'msg-1', type: 'assistant', catId: 'opus', content: 'body', timestamp: 1 }}
          threadId="thread-1"
        >
          <div data-testid="expanded-thinking">thinking content grew before CLI</div>
          <div data-context-quote-source="cli_output">
            <span data-context-quote-segment-id="stdout">target output</span>
          </div>
        </MessageActions>,
      );
    });
    expect(document.body.querySelector('[data-testid="context-annotation-marker-ctx-quote-collapsed-cli"]')).toBeNull();

    act(() => window.dispatchEvent(new Event('catcafe:chat-layout-changed')));
    expect(
      document.body.querySelector<HTMLButtonElement>(
        '[data-testid="context-annotation-marker-ctx-quote-collapsed-cli"]',
      )?.textContent,
    ).toBe('1');
  });

  it('keeps a stdout annotation on the stdout leaf when a tool detail expands before it', () => {
    const resolvedTexts: string[] = [];
    Object.defineProperty(Range.prototype, 'getBoundingClientRect', {
      configurable: true,
      value(this: Range) {
        resolvedTexts.push(this.toString());
        return rect();
      },
    });
    syncContextAttachmentDraftToStorage('thread-1', [
      {
        v: 1,
        id: 'ctx-quote-cli-stdout',
        kind: 'quote',
        text: 'target',
        comment: 'stdout comment',
        selectionStart: 0,
        selectionEnd: 6,
        source: { kind: 'cli_output', threadId: 'thread-1', messageId: 'msg-1', segmentId: 'stdout' },
      },
    ]);

    renderMessage(
      <div data-context-quote-source="cli_output">
        <span data-context-quote-segment-id="tool-label:tool-1">tool label</span>
        <span data-context-quote-segment-id="stdout">target output</span>
      </div>,
    );
    expect(resolvedTexts.at(-1)).toBe('target');

    act(() => {
      root.render(
        <MessageActions
          message={{ id: 'msg-1', type: 'assistant', catId: 'opus', content: 'body', timestamp: 1 }}
          threadId="thread-1"
        >
          <div data-context-quote-source="cli_output">
            <span data-context-quote-segment-id="tool-label:tool-1">tool label</span>
            <span data-context-quote-segment-id="tool-detail:tool-1">expanded result before stdout</span>
            <span data-context-quote-segment-id="stdout">target output</span>
          </div>
        </MessageActions>,
      );
    });
    act(() => window.dispatchEvent(new Event('catcafe:chat-layout-changed')));

    expect(resolvedTexts.at(-1)).toBe('target');
    expect(
      document.body.querySelector('[data-testid="context-annotation-marker-ctx-quote-cli-stdout"]'),
    ).not.toBeNull();
  });

  it('hides a tool-detail annotation when its semantic leaf collapses instead of moving it to stdout', () => {
    const resolvedTexts: string[] = [];
    Object.defineProperty(Range.prototype, 'getBoundingClientRect', {
      configurable: true,
      value(this: Range) {
        resolvedTexts.push(this.toString());
        return rect();
      },
    });
    syncContextAttachmentDraftToStorage('thread-1', [
      {
        v: 1,
        id: 'ctx-quote-cli-tool-detail',
        kind: 'quote',
        text: 'target detail',
        comment: 'tool detail comment',
        selectionStart: 0,
        selectionEnd: 13,
        source: {
          kind: 'cli_output',
          threadId: 'thread-1',
          messageId: 'msg-1',
          segmentId: 'tool-detail:tool-1',
        },
      },
    ]);

    renderMessage(
      <div data-context-quote-source="cli_output">
        <span data-context-quote-segment-id="tool-detail:tool-1">target detail</span>
        <span data-context-quote-segment-id="stdout">unrelated stdout</span>
      </div>,
    );
    expect(resolvedTexts.at(-1)).toBe('target detail');
    expect(
      document.body.querySelector('[data-testid="context-annotation-marker-ctx-quote-cli-tool-detail"]'),
    ).not.toBeNull();

    act(() => {
      root.render(
        <MessageActions
          message={{ id: 'msg-1', type: 'assistant', catId: 'opus', content: 'body', timestamp: 1 }}
          threadId="thread-1"
        >
          <div data-context-quote-source="cli_output">
            <span data-context-quote-segment-id="stdout">unrelated stdout</span>
          </div>
        </MessageActions>,
      );
    });
    act(() => window.dispatchEvent(new Event('catcafe:chat-layout-changed')));

    expect(
      document.body.querySelector('[data-testid="context-annotation-marker-ctx-quote-cli-tool-detail"]'),
    ).toBeNull();
    expect(resolvedTexts).not.toContain('unrelated st');
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

    expect(document.body.querySelector('[data-testid="message-selection-add-to-chat"]')).toBeNull();
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

    expect(document.body.querySelector('[data-testid="message-selection-add-to-chat"]')).toBeNull();
    expect(useChatStore.getState().pendingChatInsert).toBeNull();
  });

  it('hides the action when nested scrolling moves every selection fragment out of view', () => {
    renderMessage(<span data-testid="message-text">selected message text</span>);
    const textNode = container.querySelector('[data-testid="message-text"]')?.firstChild;
    if (!textNode) throw new Error('message text missing');

    act(() => mockSelection(textNode, 'selected message text', rect));
    expect(document.body.querySelector('[data-testid="message-selection-add-to-chat"]')).not.toBeNull();

    top = window.innerHeight + 100;
    act(() => document.dispatchEvent(new Event('scroll')));
    expect(document.body.querySelector('[data-testid="message-selection-add-to-chat"]')).toBeNull();
  });
});
