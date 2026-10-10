import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConnectorBubble } from '@/components/ConnectorBubble';
import { MessageActions } from '@/components/MessageActions';
import type { ChatMessage } from '@/stores/chatStore';

vi.mock('@/hooks/useTextSelectionAction', () => ({
  useTextSelectionAction: () => null,
}));

vi.mock('@/components/useMessageAnnotationMarkers', () => ({
  useMessageAnnotationMarkers: () => [],
}));

describe('ConnectorBubble message actions', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    React.act(() => root.unmount());
    container.remove();
  });

  it('hosts the ordinary History quote action in the bubble header', () => {
    const message: ChatMessage = {
      id: 'github-review-1',
      type: 'connector',
      content: 'Maintainer requested lifecycle changes.',
      timestamp: 1,
      source: {
        connector: 'github-review',
        label: 'GitHub Review',
        icon: 'github',
      },
    };

    React.act(() => {
      root.render(
        <MessageActions message={message} threadId="thread-1">
          <ConnectorBubble message={message} threadId="thread-1" />
        </MessageActions>,
      );
    });

    const slot = container.querySelector('[data-message-action-slot]');
    expect(slot).not.toBeNull();
    expect(slot?.querySelector('[data-testid="message-actions-toolbar"]')).not.toBeNull();
    expect(slot?.querySelector('button[title="引用回复"]')).not.toBeNull();
  });
});
