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

  it('keeps ordinary Markdown links as links instead of promoting them to attachments', () => {
    act(() => {
      root.render(<ContentBlocks blocks={[{ type: 'text', text: '[ordinary](/thread/thread-target)' }]} />);
    });

    expect(container.querySelector('a[href="/thread/thread-target"]')?.textContent).toBe('ordinary');
    expect(container.querySelector('[data-context-kind]')).toBeNull();
  });
});
