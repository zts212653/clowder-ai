/**
 * QueuePanel: processing entries should NOT be visible
 * (processing = already executing, user sees it in chat area)
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { QueueEntry } from '@/stores/chat-types';
import { useChatStore } from '@/stores/chatStore';
import { QueuePanel } from '../QueuePanel';

vi.mock('@/utils/api-client', () => ({
  apiFetch: vi.fn(async () => ({ ok: true, json: async () => ({}) })),
}));

const NOW = Date.now();

const QUEUED_ENTRY: QueueEntry = {
  id: 'q1',
  threadId: 'thread-1',
  userId: 'u1',
  content: 'queued message',
  messageId: 'm1',
  mergedMessageIds: [],
  source: 'user',
  targetCats: ['opus'],
  intent: 'execute',
  status: 'queued',
  createdAt: NOW,
};

const PROCESSING_ENTRY: QueueEntry = {
  ...QUEUED_ENTRY,
  id: 'q-proc',
  content: 'processing message',
  status: 'processing',
};

describe('QueuePanel hides processing entries', () => {
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
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  it('does NOT render processing-only queue', () => {
    useChatStore.setState({ queue: [PROCESSING_ENTRY] });
    act(() => {
      root.render(React.createElement(QueuePanel, { threadId: 'thread-1' }));
    });

    // Processing entry should not be visible — panel should be empty/hidden
    expect(container.innerHTML).not.toContain('processing message');
  });

  it('renders queued entries but hides processing entries', () => {
    useChatStore.setState({ queue: [PROCESSING_ENTRY, QUEUED_ENTRY] });
    act(() => {
      root.render(React.createElement(QueuePanel, { threadId: 'thread-1' }));
    });

    const html = container.innerHTML;
    // Only queued entry visible
    expect(html).toContain('queued message');
    expect(html).not.toContain('processing message');
    // Steer button for queued entry
    expect(container.querySelector('[data-testid="steer-q1"]')).not.toBeNull();
  });
});
