/**
 * F39 Bug 2: QueuePanel should show image count indicator
 * when the associated message has image contentBlocks.
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { QueueEntry } from '@/stores/chat-types';
import { useChatStore } from '@/stores/chatStore';
import { QueuePanel } from '../QueuePanel';

const NOW = Date.now();

const QUEUE_ENTRY_BASE: QueueEntry = {
  id: 'q1',
  threadId: 'thread-1',
  userId: 'u1',
  content: 'hello with image',
  messageId: 'msg-1',
  mergedMessageIds: [],
  source: 'user',
  targetCats: ['opus'],
  intent: 'execute',
  status: 'queued',
  createdAt: NOW,
};

describe('QueuePanel image indicator (F39 Bug 2)', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    (globalThis as { React?: typeof React }).React = React;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterAll(() => {
    delete (globalThis as { React?: typeof React }).React;
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    useChatStore.setState({
      messages: [],
      queue: [],
      queuePaused: false,
      currentThreadId: 'thread-1',
    });
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it('shows image count when associated message has image contentBlocks', () => {
    // #706: image count now comes from server-enriched messagePreview, not client messages store
    useChatStore.setState({
      queue: [
        {
          ...QUEUE_ENTRY_BASE,
          messagePreview: {
            contentBlocks: [{ type: 'image', url: 'https://example.com/cat.png' }],
          },
        },
      ],
      messages: [],
    });

    act(() => {
      root.render(React.createElement(QueuePanel, { threadId: 'thread-1' }));
    });

    const html = container.innerHTML;
    // Should render the queue entry content
    expect(html).toContain('hello with image');
    // Should contain the image count "1" via the SVG landscape icon
    expect(html).toContain('l4-8 3 6'); // SVG path unique to image icon
  });

  it('shows count for multiple images', () => {
    // #706: image count from messagePreview.contentBlocks (server-enriched)
    useChatStore.setState({
      queue: [
        {
          ...QUEUE_ENTRY_BASE,
          content: 'multi-image',
          messagePreview: {
            contentBlocks: [
              { type: 'image', url: 'https://example.com/a.png' },
              { type: 'image', url: 'https://example.com/b.png' },
              { type: 'text', text: 'some text' },
            ],
          },
        },
      ],
      messages: [],
    });

    act(() => {
      root.render(React.createElement(QueuePanel, { threadId: 'thread-1' }));
    });

    const html = container.innerHTML;
    expect(html).toContain('multi-image');
    // "2" for two images (text block excluded)
    expect(html).toContain('>2<');
  });

  it('does not show image indicator when messagePreview has no images', () => {
    // #706: no imagePreview → imageCount = 0 → no icon
    useChatStore.setState({
      queue: [
        {
          ...QUEUE_ENTRY_BASE,
          content: 'text only',
          messagePreview: { contentBlocks: [{ type: 'text', text: 'text only' }] },
        },
      ],
      messages: [],
    });

    act(() => {
      root.render(React.createElement(QueuePanel, { threadId: 'thread-1' }));
    });

    const html = container.innerHTML;
    expect(html).toContain('text only');
    // No image icon SVG path
    expect(html).not.toContain('l4-8 3 6');
  });

  it('does not show image indicator when messageId is null', () => {
    useChatStore.setState({
      queue: [{ ...QUEUE_ENTRY_BASE, messageId: null, content: 'no link' }],
      messages: [],
    });

    act(() => {
      root.render(React.createElement(QueuePanel, { threadId: 'thread-1' }));
    });

    const html = container.innerHTML;
    expect(html).toContain('no link');
    expect(html).not.toContain('l4-8 3 6');
  });

  it('counts images from merged messages too (Cloud R2 P2)', () => {
    // #706: server enrichment merges all contentBlocks (primary + merged) into messagePreview at emit time
    useChatStore.setState({
      queue: [
        {
          ...QUEUE_ENTRY_BASE,
          content: 'merged entry',
          messageId: 'msg-1',
          mergedMessageIds: ['msg-2'],
          messagePreview: {
            // Server has already merged contentBlocks from msg-1 + msg-2
            contentBlocks: [
              { type: 'image', url: 'https://example.com/a.png' },
              { type: 'image', url: 'https://example.com/b.png' },
              { type: 'image', url: 'https://example.com/c.png' },
            ],
          },
        },
      ],
      messages: [],
    });

    act(() => {
      root.render(React.createElement(QueuePanel, { threadId: 'thread-1' }));
    });

    const html = container.innerHTML;
    // 1 from msg-1 + 2 from msg-2 = 3 total
    expect(html).toContain('>3<');
    expect(html).toContain('l4-8 3 6'); // image icon present
  });

  it('renders nothing when queue is empty', () => {
    useChatStore.setState({ queue: [] });

    act(() => {
      root.render(React.createElement(QueuePanel, { threadId: 'thread-1' }));
    });

    expect(container.innerHTML).toBe('');
  });
});
