import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { projectCanonicalBubbles } from '@/stores/bubble-projection';
import type { ChatMessage as ChatMessageData } from '@/stores/chat-types';
import { useChatStore } from '@/stores/chatStore';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@/hooks/useTts', () => ({
  useTts: () => ({ state: 'idle', synthesize: vi.fn(), activeMessageId: null }),
}));
vi.mock('@/hooks/useCatData', () => ({
  useCatData: () => ({ cats: [], isLoading: false, getCatById: () => undefined, getCatsByBreed: () => new Map() }),
}));
vi.mock('../TransferTargetPicker', async () => {
  const { createElement } = await vi.importActual<typeof import('react')>('react');
  return {
    TransferTargetPicker: ({ open, items }: { open: boolean; items: unknown[] }) =>
      open
        ? createElement('output', {
            'data-testid': 'r21-forward-picker-probe',
            'data-items': JSON.stringify(items),
          })
        : null,
  };
});

const { ChatMessageRow } = await import('../ChatMessageRow');

function selectNodeText(node: Text) {
  const rect = () => ({ top: 120, right: 300, bottom: 140, left: 120, width: 180, height: 20 }) as DOMRect;
  const range = document.createRange();
  range.selectNodeContents(node);
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

function exactTextNode(root: ParentNode, selector: string, expected: string): Text {
  const source = root.querySelector(selector);
  if (!source) throw new Error(`real source missing: ${selector}`);
  const walker = document.createTreeWalker(source, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.textContent === expected && node instanceof Text) return node;
  }
  throw new Error(`real source text missing: ${expected}`);
}

function transferPickerItems(root: ParentNode): unknown[] {
  const probe = root.querySelector<HTMLOutputElement>('[data-testid="r21-forward-picker-probe"]');
  if (!probe?.dataset.items) throw new Error('real R21 transfer picker payload missing');
  return JSON.parse(probe.dataset.items) as unknown[];
}

describe('ChatMessageRow R21 cached stdout forwarding', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    (globalThis as { React?: typeof React }).React = React;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    useChatStore.setState({ currentThreadId: 'source-thread' });
    useChatStore.getState().setUiThinkingExpandedByDefault(false);
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

  it('carries the browser-visible cached speech through the real CLI v2 selection path', () => {
    const rawMessage: ChatMessageData = {
      id: 'cached-r21-stream-only',
      type: 'assistant',
      catId: 'codex-sol',
      content: '',
      origin: 'stream',
      timestamp: 1,
      isStreaming: false,
      projectionSourceMessageIds: ['cached-r21-stream-only'],
      extra: {
        stream: {
          invocationId: 'inv-cached-r21',
          turnInvocationId: 'turn-cached-r21',
          cliStdout: '',
          speechContent: 'CACHED_R21_SPEECH',
        },
      },
    };
    const [message] = projectCanonicalBubbles({ records: [rawMessage] }).messages;
    if (!message) throw new Error('cached R21 bubble projection missing');
    expect(message.content).toBe('CACHED_R21_SPEECH');
    expect(message.extra?.stream?.cliStdout).toBeUndefined();
    expect(message.extra?.stream?.speechContent).toBeUndefined();

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
          forwardingDisabled={false}
          eager
        />,
      );
    });

    const cliToggle = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find((button) =>
      button.textContent?.includes('CLI Output'),
    );
    if (!cliToggle) throw new Error('real CLI disclosure toggle missing');
    act(() => cliToggle.click());

    const textNode = exactTextNode(container, '[data-context-quote-segment-id="stdout"]', 'CACHED_R21_SPEECH');
    act(() => selectNodeText(textNode));
    act(() => document.body.querySelector<HTMLButtonElement>('[data-testid="message-selection-add-to-chat"]')?.click());
    act(() => document.body.querySelector<HTMLButtonElement>('[data-testid="context-annotation-forward"]')?.click());

    expect(transferPickerItems(container)).toEqual([
      {
        kind: 'cli_quote',
        messageId: message.id,
        sourceMessageIds: [message.id],
        segmentId: 'stdout',
        text: 'CACHED_R21_SPEECH',
        selectionStart: 0,
        selectionEnd: 'CACHED_R21_SPEECH'.length,
        sourceProjectionVersion: 2,
        renderedOccurrences: 1,
      },
    ]);
  });
});
