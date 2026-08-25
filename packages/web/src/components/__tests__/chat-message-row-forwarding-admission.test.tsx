import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage as ChatMessageData } from '@/stores/chat-types';

vi.mock('../ChatMessage', () => ({
  ChatMessage: () => (
    <div data-context-quote-source="cli_output">
      <span data-testid="row-cli-source" data-context-quote-segment-id="stdout">
        selected source text
      </span>
    </div>
  ),
}));

vi.mock('../TransferTargetPicker', async () => {
  const { createElement } = await vi.importActual<typeof import('react')>('react');
  return {
    TransferTargetPicker: ({ open }: { open: boolean }) =>
      open ? createElement('output', { 'data-testid': 'row-forward-picker-probe' }) : null,
  };
});

const { ChatMessageRow } = await import('../ChatMessageRow');

function selectText(node: Node) {
  const rect = () => ({ top: 120, right: 260, bottom: 140, left: 120, width: 140, height: 20 }) as DOMRect;
  vi.spyOn(window, 'getSelection').mockReturnValue({
    isCollapsed: false,
    anchorNode: node,
    focusNode: node,
    toString: () => 'selected source text',
    rangeCount: 1,
    getRangeAt: () => ({
      getClientRects: () => [rect()],
      getBoundingClientRect: rect,
      commonAncestorContainer: node,
      toString: () => 'selected source text',
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

describe('ChatMessageRow forwarding admission', () => {
  let container: HTMLDivElement;
  let root: Root;
  const message: ChatMessageData = {
    id: 'row-source-message',
    type: 'assistant',
    catId: 'opus',
    content: 'body',
    timestamp: 1,
    projectionSourceMessageIds: ['row-source-message'],
  };

  beforeAll(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  afterAll(() => {
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  function renderRow(forwardingDisabled: boolean) {
    act(() => {
      root.render(
        <ChatMessageRow
          message={message}
          threadId="source-thread"
          timelineMessages={[message]}
          getCatById={() => undefined}
          onEditCat={() => {}}
          onEditCoCreator={() => {}}
          selectionMode={false}
          selected={false}
          selectionEligible
          onEnterSelection={() => {}}
          onToggleSelection={() => {}}
          forwardingDisabled={forwardingDisabled}
          eager
        />,
      );
    });
  }

  it('keeps the real direct CLI route local-only until the document is admitted', () => {
    renderRow(true);
    const source = container.querySelector('[data-testid="row-cli-source"]')?.firstChild;
    if (!source) throw new Error('row CLI source missing');
    act(() => selectText(source));
    act(() => document.body.querySelector<HTMLButtonElement>('[data-testid="message-selection-add-to-chat"]')?.click());

    expect(document.body.querySelector('[data-testid="context-annotation-save"]')).not.toBeNull();
    expect(document.body.querySelector('[data-testid="context-annotation-forward"]')).toBeNull();

    renderRow(false);

    expect(document.body.querySelector('[data-testid="context-annotation-forward"]')).not.toBeNull();
  });
});
