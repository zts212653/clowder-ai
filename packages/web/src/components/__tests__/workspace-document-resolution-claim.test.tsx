import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatWorkspaceLink } from '@/components/ChatWorkspaceLink';
import { useChatStore } from '@/stores/chatStore';

Object.assign(globalThis as Record<string, unknown>, { React, IS_REACT_ACT_ENVIRONMENT: true });

const { apiFetchMock } = vi.hoisted(() => ({ apiFetchMock: vi.fn() }));

vi.mock('@/utils/api-client', () => ({
  API_URL: 'http://localhost:3004',
  apiFetch: apiFetchMock,
}));

describe('Workspace document resolution claim custody', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    apiFetchMock.mockReset();
    apiFetchMock.mockImplementation(() => new Promise<Response>(() => {}));
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    useChatStore.setState({
      currentThreadId: 'thread-a',
      currentProjectPath: '/work/cat-cafe',
      workspaceOpenFilePath: null,
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    useChatStore.setState({
      currentThreadId: 'default',
      currentProjectPath: 'default',
      workspaceOpenFilePath: null,
    });
  });

  it('re-enables the previous link immediately when a newer claim cancels its stalled request', async () => {
    act(() => {
      root.render(
        <>
          <ChatWorkspaceLink href="/work/other-a/docs/a.md">A</ChatWorkspaceLink>
          <ChatWorkspaceLink href="/work/other-b/docs/b.md">B</ChatWorkspaceLink>
        </>,
      );
    });
    const [first, second] = Array.from(container.querySelectorAll('button'));

    await act(async () => {
      first.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      await Promise.resolve();
    });
    expect(first.disabled).toBe(true);

    await act(async () => {
      second.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      await Promise.resolve();
    });

    expect(first.disabled).toBe(false);
    expect(second.disabled).toBe(true);
  });
});
