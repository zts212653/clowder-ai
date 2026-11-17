import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MarkdownContent } from '@/components/MarkdownContent';
import { CHAT_THREAD_ROUTE_EVENT } from '@/components/ThreadSidebar/thread-navigation';
import { useChatStore } from '@/stores/chatStore';
import { apiFetch } from '@/utils/api-client';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn(), API_URL: 'http://localhost:3172' }));
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal('React', React);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.mocked(apiFetch).mockResolvedValue(Response.json({ groups: [] }));
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  useChatStore.setState({ currentThreadId: 'thread_assistant', currentProjectPath: '/isolated/project' });
  window.history.replaceState({}, '', '/thread/thread_assistant');
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

it.each([
  '[打开会话](/thread/thread_target)',
  '| 事项 |\n| --- |\n| [打开会话](/thread/thread_target) |',
])('a thread link in real reference-enabled Markdown navigates inside the current application: %s', async content => {
  const onRoute = vi.fn();
  const open = vi.spyOn(window, 'open');
  window.addEventListener(CHAT_THREAD_ROUTE_EVENT, onRoute);
  await act(async () => root.render(<MarkdownContent referenceThreadId="thread_assistant" content={content} />));
  const anchor = container.querySelector('a[href="/thread/thread_target"]');
  expect(anchor?.textContent).toBe('打开会话');
  expect(anchor?.getAttribute('target')).toBeNull();
  const click = new MouseEvent('click', { bubbles: true, cancelable: true });
  act(() => anchor?.dispatchEvent(click));
  expect(click.defaultPrevented).toBe(true);
  expect(window.location.pathname).toBe('/thread/thread_target');
  expect(onRoute).toHaveBeenCalledOnce();
  expect(open).not.toHaveBeenCalled();
  expect(apiFetch).not.toHaveBeenCalled();
  window.removeEventListener(CHAT_THREAD_ROUTE_EVENT, onRoute);
  open.mockRestore();
});
