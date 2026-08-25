import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { useChatStore } from '@/stores/chatStore';

vi.mock('@/components/TransferTargetPicker', async () => {
  const { createElement } = await vi.importActual<typeof import('react')>('react');
  return {
    TransferTargetPicker: ({ open, items }: { open: boolean; items: unknown[] }) =>
      open
        ? createElement('output', {
            'data-testid': 'forward-picker-probe',
            'data-items': JSON.stringify(items),
          })
        : null,
  };
});

const { MessageActions } = await import('@/components/MessageActions');

function setTextareaValue(textarea: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
  setter?.call(textarea, value);
  textarea.dispatchEvent(new Event('input', { bubbles: true }));
}

function selectText(node: Node, text: string) {
  const rect = () => ({ top: 120, right: 260, bottom: 140, left: 120, width: 140, height: 20 }) as DOMRect;
  vi.spyOn(window, 'getSelection').mockReturnValue({
    isCollapsed: false,
    anchorNode: node,
    focusNode: node,
    toString: () => text,
    rangeCount: 1,
    getRangeAt: () => ({
      getClientRects: () => [rect()],
      getBoundingClientRect: rect,
      commonAncestorContainer: node,
      toString: () => text,
      cloneRange: () => ({
        selectNodeContents: vi.fn(),
        setEnd: vi.fn(),
        toString: () => '',
      }),
    }),
    removeAllRanges: vi.fn(),
  } as unknown as Selection);
  document.dispatchEvent(new Event('selectionchange'));
}

function selectRange(node: Text, start: number, end: number) {
  const rect = () => ({ top: 120, right: 260, bottom: 140, left: 120, width: 140, height: 20 }) as DOMRect;
  const range = document.createRange();
  range.setStart(node, start);
  range.setEnd(node, end);
  Object.defineProperties(range, {
    getClientRects: { value: () => [rect()] },
    getBoundingClientRect: { value: rect },
  });
  vi.spyOn(window, 'getSelection').mockReturnValue({
    isCollapsed: false,
    anchorNode: node,
    focusNode: node,
    toString: () => range.toString(),
    rangeCount: 1,
    getRangeAt: () => range,
    removeAllRanges: vi.fn(),
  } as unknown as Selection);
  document.dispatchEvent(new Event('selectionchange'));
}

describe('Message quote forwarding', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    useChatStore.setState({
      currentThreadId: 'source-thread',
      pendingChatInsert: {
        threadId: 'source-thread',
        text: 'existing composer draft',
      },
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  afterAll(() => {
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  function sourceElement(sourceKind: 'message' | 'cli_output', forwardingDisabled = false) {
    return (
      <MessageActions
        message={{
          id: 'source-message-1',
          type: 'assistant',
          catId: 'opus',
          content: 'body',
          timestamp: 1,
          projectionSourceMessageIds: ['source-stream-1', 'source-message-1'],
        }}
        threadId="source-thread"
        forwardingDisabled={forwardingDisabled}
      >
        <div {...(sourceKind === 'cli_output' ? { 'data-context-quote-source': 'cli_output' } : {})}>
          <span
            data-testid="source-text"
            {...(sourceKind === 'cli_output' ? { 'data-context-quote-segment-id': 'stdout' } : {})}
          >
            selected source text
          </span>
        </div>
      </MessageActions>
    );
  }

  function renderSource(sourceKind: 'message' | 'cli_output', forwardingDisabled = false) {
    act(() => {
      root.render(sourceElement(sourceKind, forwardingDisabled));
    });
    const textNode = container.querySelector('[data-testid="source-text"]')?.firstChild;
    if (!textNode) throw new Error('source text missing');
    act(() => selectText(textNode, 'selected source text'));
    act(() => document.body.querySelector<HTMLButtonElement>('[data-testid="message-selection-add-to-chat"]')?.click());
  }

  it('passes an exact Quote plus optional Comment to the picker without replacing the composer draft', () => {
    renderSource('message');
    const comment = document.body.querySelector<HTMLTextAreaElement>('[data-testid="context-annotation-comment"]');
    if (!comment) throw new Error('quote comment editor missing');
    act(() => setTextareaValue(comment, 'why this matters'));
    act(() => document.body.querySelector<HTMLButtonElement>('[data-testid="context-annotation-forward"]')?.click());

    const probe = container.querySelector<HTMLOutputElement>('[data-testid="forward-picker-probe"]');
    expect(JSON.parse(probe?.dataset.items ?? '[]')).toEqual([
      {
        kind: 'quote',
        messageId: 'source-message-1',
        text: 'selected source text',
        // The selecting browser asserts on-screen uniqueness; admission requires exactly 1.
        renderedOccurrences: 1,
        selectionStart: 0,
        selectionEnd: 20,
        comment: 'why this matters',
      },
    ]);
    expect(useChatStore.getState().pendingChatInsert).toEqual({
      threadId: 'source-thread',
      text: 'existing composer draft',
    });
  });

  it('forwards an exact CLI segment range with the projected source-record refs', () => {
    renderSource('cli_output');

    expect(document.body.querySelector('[data-testid="context-annotation-forward"]')).not.toBeNull();
    expect(document.body.querySelector('[data-testid="context-annotation-save"]')).not.toBeNull();
    act(() => document.body.querySelector<HTMLButtonElement>('[data-testid="context-annotation-forward"]')?.click());

    const probe = container.querySelector<HTMLOutputElement>('[data-testid="forward-picker-probe"]');
    expect(JSON.parse(probe?.dataset.items ?? '[]')).toEqual([
      {
        kind: 'cli_quote',
        messageId: 'source-message-1',
        sourceMessageIds: ['source-stream-1', 'source-message-1'],
        segmentId: 'stdout',
        text: 'selected source text',
        selectionStart: 0,
        selectionEnd: 20,
      },
    ]);
  });

  it('labels Markdown-rendered CLI stdout with its readable projection and browser uniqueness proof', () => {
    act(() => {
      root.render(
        <MessageActions
          message={{
            id: 'source-message-1',
            type: 'assistant',
            catId: 'opus',
            content: '| Surface | Status |\n| --- | --- |\n| Hub | `green` |',
            timestamp: 1,
            projectionSourceMessageIds: ['source-stream-1', 'source-message-1'],
          }}
          threadId="source-thread"
        >
          <div data-context-quote-source="cli_output">
            <span
              data-testid="source-text"
              data-context-quote-segment-id="stdout"
              data-context-quote-projection-version="2"
            >
              Hub green
            </span>
          </div>
        </MessageActions>,
      );
    });
    const textNode = container.querySelector('[data-testid="source-text"]')?.firstChild;
    if (!textNode) throw new Error('source text missing');
    act(() => selectText(textNode, 'Hub green'));
    act(() => document.body.querySelector<HTMLButtonElement>('[data-testid="message-selection-add-to-chat"]')?.click());
    act(() => document.body.querySelector<HTMLButtonElement>('[data-testid="context-annotation-forward"]')?.click());

    const probe = container.querySelector<HTMLOutputElement>('[data-testid="forward-picker-probe"]');
    expect(JSON.parse(probe?.dataset.items ?? '[]')).toEqual([
      {
        kind: 'cli_quote',
        messageId: 'source-message-1',
        sourceMessageIds: ['source-stream-1', 'source-message-1'],
        segmentId: 'stdout',
        text: 'Hub green',
        selectionStart: 0,
        selectionEnd: 9,
        sourceProjectionVersion: 2,
        renderedOccurrences: 1,
      },
    ]);
  });

  it.each([
    'before the first health verification',
    'after a deployment mismatch',
  ])('does not offer direct CLI forwarding %s', () => {
    renderSource('cli_output', true);

    expect(document.body.querySelector('[data-testid="context-annotation-save"]')).not.toBeNull();
    expect(document.body.querySelector('[data-testid="context-annotation-forward"]')).toBeNull();
    expect(container.querySelector('[data-testid="forward-picker-probe"]')).toBeNull();
  });

  it('closes a direct CLI picker when a deployment mismatch is learned after it opened', () => {
    renderSource('cli_output');
    act(() => document.body.querySelector<HTMLButtonElement>('[data-testid="context-annotation-forward"]')?.click());
    expect(container.querySelector('[data-testid="forward-picker-probe"]')).not.toBeNull();

    act(() => root.render(sourceElement('cli_output', true)));

    expect(container.querySelector('[data-testid="forward-picker-probe"]')).toBeNull();
  });

  it('keeps CLI range coordinates aligned when the dragged selection includes surrounding whitespace', () => {
    const rawText = '  selected source text  ';
    act(() => {
      root.render(
        <MessageActions
          message={{
            id: 'source-message-1',
            type: 'assistant',
            catId: 'opus',
            content: rawText,
            timestamp: 1,
            projectionSourceMessageIds: ['source-stream-1', 'source-message-1'],
          }}
          threadId="source-thread"
        >
          <div data-context-quote-source="cli_output">
            <span data-testid="source-text" data-context-quote-segment-id="stdout">
              {rawText}
            </span>
          </div>
        </MessageActions>,
      );
    });
    const textNode = container.querySelector('[data-testid="source-text"]')?.firstChild;
    if (!(textNode instanceof Text)) throw new Error('source text missing');
    act(() => selectRange(textNode, 0, rawText.length));
    act(() => document.body.querySelector<HTMLButtonElement>('[data-testid="message-selection-add-to-chat"]')?.click());
    act(() => document.body.querySelector<HTMLButtonElement>('[data-testid="context-annotation-forward"]')?.click());

    const probe = container.querySelector<HTMLOutputElement>('[data-testid="forward-picker-probe"]');
    expect(JSON.parse(probe?.dataset.items ?? '[]')).toEqual([
      {
        kind: 'cli_quote',
        messageId: 'source-message-1',
        sourceMessageIds: ['source-stream-1', 'source-message-1'],
        segmentId: 'stdout',
        text: 'selected source text',
        selectionStart: 2,
        selectionEnd: 22,
      },
    ]);
  });

  it('does not offer forwarding while the CLI source bubble is still streaming', () => {
    act(() => {
      root.render(
        <MessageActions
          message={{
            id: 'source-message-1',
            type: 'assistant',
            catId: 'opus',
            content: 'body',
            timestamp: 1,
            isStreaming: true,
          }}
          threadId="source-thread"
        >
          <div data-context-quote-source="cli_output">
            <span data-testid="source-text" data-context-quote-segment-id="stdout">
              selected source text
            </span>
          </div>
        </MessageActions>,
      );
    });
    const textNode = container.querySelector('[data-testid="source-text"]')?.firstChild;
    if (!textNode) throw new Error('source text missing');
    act(() => selectText(textNode, 'selected source text'));

    expect(document.body.querySelector('[data-testid="message-selection-add-to-chat"]')).toBeNull();
  });

  it('renames the floating selection trigger to a destination-neutral quote action', () => {
    act(() => {
      root.render(
        <MessageActions
          message={{ id: 'source-message-1', type: 'assistant', catId: 'opus', content: 'body', timestamp: 1 }}
          threadId="source-thread"
        >
          <span data-testid="source-text">selected source text</span>
        </MessageActions>,
      );
    });
    const textNode = container.querySelector('[data-testid="source-text"]')?.firstChild;
    if (!textNode) throw new Error('source text missing');
    act(() => selectText(textNode, 'selected source text'));

    const trigger = document.body.querySelector('[data-testid="message-selection-add-to-chat"]');
    expect(trigger?.textContent).toContain('引用…');
    expect(trigger?.classList.contains('min-h-11')).toBe(true);
    expect(trigger?.classList.contains('min-w-11')).toBe(true);
  });
});
