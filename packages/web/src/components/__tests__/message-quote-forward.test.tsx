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
    }),
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

  function renderSource(sourceKind: 'message' | 'cli_output') {
    act(() => {
      root.render(
        <MessageActions
          message={{ id: 'source-message-1', type: 'assistant', catId: 'opus', content: 'body', timestamp: 1 }}
          threadId="source-thread"
        >
          <div {...(sourceKind === 'cli_output' ? { 'data-context-quote-source': 'cli_output' } : {})}>
            <span data-testid="source-text">selected source text</span>
          </div>
        </MessageActions>,
      );
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
        comment: 'why this matters',
      },
    ]);
    expect(useChatStore.getState().pendingChatInsert).toEqual({
      threadId: 'source-thread',
      text: 'existing composer draft',
    });
  });

  it('does not expose Forward for non-message selections', () => {
    renderSource('cli_output');

    expect(document.body.querySelector('[data-testid="context-annotation-forward"]')).toBeNull();
    expect(document.body.querySelector('[data-testid="context-annotation-save"]')).not.toBeNull();
  });
});
