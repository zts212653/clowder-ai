import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ContentBlocks } from '@/components/ContentBlocks';
import { useChatStore } from '@/stores/chatStore';

describe('ContextAttachment rendering', () => {
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
    useChatStore.setState({ currentThreadId: 'thread-current', workspaceOpenFilePath: null });
    window.history.replaceState({}, '', '/thread/thread-current');
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  afterAll(() => {
    delete (globalThis as { React?: typeof React }).React;
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it('renders Thread and Workspace File blocks as rich clickable cards', () => {
    act(() => {
      root.render(
        <ContentBlocks
          blocks={[
            {
              type: 'context_attachment',
              attachment: {
                v: 1,
                id: 'ctx-thread-render',
                kind: 'thread',
                threadId: 'thread-target',
                title: 'Target Thread',
              },
            },
            {
              type: 'context_attachment',
              attachment: {
                v: 1,
                id: 'ctx-file-render',
                kind: 'workspace_file',
                path: 'docs/features/F063.md',
                worktreeId: 'wt-f063',
                lineStart: 25,
              },
            },
          ]}
        />,
      );
    });

    const cards = container.querySelectorAll('[data-context-kind]');
    expect(cards).toHaveLength(2);
    act(() => (cards[0].querySelector('button') as HTMLButtonElement).click());
    expect(window.location.pathname).toBe('/thread/thread-target');

    act(() => (cards[1].querySelector('button') as HTMLButtonElement).click());
    expect(useChatStore.getState().workspaceOpenFilePath).toBe('docs/features/F063.md');
    expect(useChatStore.getState().workspaceOpenFileLine).toBe(25);
    expect(useChatStore.getState().workspaceWorktreeId).toBe('wt-f063');
  });

  it('opens the source file of a workspace-file quote, keeping the original message as the way back', () => {
    // Real page 2026-09-23 (entry 5): "Add to chat" on a Markdown selection sends a QUOTE chip
    // whose source is the file; clicking it did nothing, so the chip was a dead end.
    act(() => {
      root.render(
        <div data-message-id="msg-quote-1">
          <ContentBlocks
            blocks={[
              {
                type: 'context_attachment',
                attachment: {
                  v: 1,
                  id: 'ctx-quote-file',
                  kind: 'quote',
                  text: '抹茶蛋糕',
                  source: { kind: 'workspace_file', path: 'desserts.md', worktreeId: 'wt-scratch', lineStart: 3 },
                },
              },
              {
                type: 'context_attachment',
                attachment: {
                  v: 1,
                  id: 'ctx-quote-message',
                  kind: 'quote',
                  text: 'an earlier reply',
                  source: { kind: 'message', threadId: 'thread-current', messageId: 'msg-earlier' },
                },
              },
            ]}
          />
        </div>,
      );
    });

    const cards = container.querySelectorAll('[data-context-kind="quote"]');
    expect(cards).toHaveLength(2);
    const fileQuoteButton = cards[0].querySelector('button');
    expect(fileQuoteButton).not.toBeNull();
    act(() => (fileQuoteButton as HTMLButtonElement).click());
    const state = useChatStore.getState();
    expect(state.workspaceOpenFilePath).toBe('desserts.md');
    expect(state.workspaceOpenFileLine).toBe(3);
    expect(state.workspaceWorktreeId).toBe('wt-scratch');
    expect(state._workspaceFileSetAt?.navigationOrigin).toEqual({
      kind: 'chat-file-link',
      threadId: 'thread-current',
      messageId: 'msg-quote-1',
    });
    // A quote of a chat message has no file to open.
    expect(cards[1].querySelector('button')).toBeNull();
  });

  it('keeps ordinary Markdown links as links instead of promoting them to attachments', () => {
    act(() => {
      root.render(<ContentBlocks blocks={[{ type: 'text', text: '[ordinary](/thread/thread-target)' }]} />);
    });

    expect(container.querySelector('a[href="/thread/thread-target"]')?.textContent).toBe('ordinary');
    expect(container.querySelector('[data-context-kind]')).toBeNull();
  });
});
