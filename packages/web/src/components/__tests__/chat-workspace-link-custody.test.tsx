import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MarkdownContent } from '@/components/MarkdownContent';
import { CHAT_THREAD_ROUTE_EVENT } from '@/components/ThreadSidebar/thread-navigation';
import { useChatStore } from '@/stores/chatStore';

Object.assign(globalThis as Record<string, unknown>, { React, IS_REACT_ACT_ENVIRONMENT: true });

const { apiFetchMock } = vi.hoisted(() => ({ apiFetchMock: vi.fn() }));

vi.mock('@/utils/api-client', () => ({
  API_URL: 'http://localhost:3004',
  apiFetch: apiFetchMock,
}));

describe('MarkdownContent document resolution custody', () => {
  let container: HTMLDivElement;
  let root: Root;
  let rootMounted: boolean;

  beforeEach(() => {
    apiFetchMock.mockReset();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    rootMounted = true;
    window.history.replaceState(null, '', '/');
    useChatStore.setState({
      currentThreadId: 'default',
      currentProjectPath: '/home/user/cat-cafe',
      workspaceWorktreeId: 'cat-cafe',
      workspaceOpenFilePath: null,
      workspaceOpenFileLine: null,
      workspaceOpenTabs: [],
      rightPanelMode: 'status',
    });
  });

  afterEach(() => {
    if (rootMounted) act(() => root.unmount());
    container.remove();
    window.history.replaceState(null, '', '/');
    useChatStore.setState({
      currentThreadId: 'default',
      currentProjectPath: 'default',
      workspaceWorktreeId: null,
      workspaceOpenFilePath: null,
      workspaceOpenFileLine: null,
      workspaceOpenTabs: [],
      rightPanelMode: 'status',
    });
  });

  function renderContent(content: string) {
    act(() => {
      root.render(<MarkdownContent content={content} disableCommandPrefix />);
    });
  }

  it('keeps a newer document click when an older resolver response arrives last', async () => {
    let resolveFirst!: (response: Response) => void;
    let resolveSecond!: (response: Response) => void;
    apiFetchMock
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            resolveFirst = resolve;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            resolveSecond = resolve;
          }),
      );
    renderContent(
      '[First](/home/user/cat-cafe-first/docs/first.md) [Second](/home/user/cat-cafe-second/docs/second.md)',
    );
    const actions = Array.from(container.querySelectorAll('button'));

    act(() => actions[0]?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })));
    act(() => actions[1]?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })));
    await act(async () => {
      resolveSecond(
        new Response(JSON.stringify({ worktreeId: 'second', path: 'docs/second.md', line: null }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
      await Promise.resolve();
    });
    expect(useChatStore.getState().workspaceOpenFilePath).toBe('docs/second.md');

    await act(async () => {
      resolveFirst(
        new Response(JSON.stringify({ worktreeId: 'first', path: 'docs/first.md', line: null }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
      await Promise.resolve();
    });

    expect(useChatStore.getState().workspaceWorktreeId).toBe('second');
    expect(useChatStore.getState().workspaceOpenFilePath).toBe('docs/second.md');
    expect(actions[0]?.disabled).toBe(false);
  });

  it('discards a document resolver response after the user switches threads', async () => {
    let resolveTarget!: (response: Response) => void;
    apiFetchMock.mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          resolveTarget = resolve;
        }),
    );
    useChatStore.setState({ currentThreadId: 'thread-a' });
    renderContent('[Guide](/home/user/cat-cafe-guide/docs/guide.md)');
    const action = container.querySelector('button');
    act(() => action?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })));
    useChatStore.setState({ currentThreadId: 'thread-b' });

    await act(async () => {
      resolveTarget(
        new Response(JSON.stringify({ worktreeId: 'guide', path: 'docs/guide.md', line: null }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
      await Promise.resolve();
    });

    expect(useChatStore.getState().workspaceOpenFilePath).toBeNull();
  });

  it('discards a document resolver response when the live browser route changes before the store thread', async () => {
    let resolveTarget!: (response: Response) => void;
    apiFetchMock.mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          resolveTarget = resolve;
        }),
    );
    window.history.replaceState(null, '', '/thread/thread-a');
    useChatStore.setState({ currentThreadId: 'thread-a' });
    renderContent('[Guide](/home/user/cat-cafe-guide/docs/guide.md)');
    const action = container.querySelector('button');
    act(() => action?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })));

    act(() => {
      window.history.pushState(null, '', '/thread/thread-b');
      window.dispatchEvent(new Event(CHAT_THREAD_ROUTE_EVENT));
    });
    expect(useChatStore.getState().currentThreadId).toBe('thread-a');

    await act(async () => {
      resolveTarget(
        new Response(JSON.stringify({ worktreeId: 'guide', path: 'docs/guide.md', line: null }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
      await Promise.resolve();
    });

    expect(useChatStore.getState().workspaceOpenFilePath).toBeNull();
  });

  it('discards a document resolver response after its link unmounts', async () => {
    let resolveTarget!: (response: Response) => void;
    apiFetchMock.mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          resolveTarget = resolve;
        }),
    );
    renderContent('[Guide](/home/user/cat-cafe-guide/docs/guide.md)');
    const action = container.querySelector('button');
    act(() => action?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })));
    act(() => root.unmount());
    rootMounted = false;

    await act(async () => {
      resolveTarget(
        new Response(JSON.stringify({ worktreeId: 'guide', path: 'docs/guide.md', line: null }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
      await Promise.resolve();
    });

    expect(useChatStore.getState().workspaceOpenFilePath).toBeNull();
  });
});
