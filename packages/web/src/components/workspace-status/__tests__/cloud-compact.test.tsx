import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CloudConversationLink } from '@/components/CloudConversationLink';
import { buttonByText, candidate, FakeHost, flush, jsonResponse } from '../../__tests__/cloud-route-test-fixtures';

const fetchMock = vi.hoisted(() => vi.fn());
vi.mock('@/utils/api-client', () => ({ apiFetch: (...args: unknown[]) => fetchMock(...args) }));
let container: HTMLDivElement;
let root: Root;
let clipboard: PropertyDescriptor | undefined;
let host: FakeHost;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  fetchMock.mockReset();
  host = new FakeHost('compact-thread');
  fetchMock.mockImplementation(
    async (path: string, init?: RequestInit, options?: unknown) =>
      host.handle(path, init, options) ?? jsonResponse({ error: 'not found' }, 404),
  );
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  clipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  if (clipboard) Object.defineProperty(navigator, 'clipboard', clipboard);
  else delete (navigator as { clipboard?: Clipboard }).clipboard;
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});

async function render() {
  await act(async () => root.render(<CloudConversationLink threadId={host.threadId} compact />));
  await flush();
}

it('compact cloud row keeps the resolved member’s full URL copy/open and in-place binding choice', async () => {
  const url = 'https://chatgpt.com/c/complete-conversation-0123456789';
  const copy = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: copy } });
  host.cloudCat = { status: 'resolved', catId: 'resolved-cloud-cat' };
  host.bindings = { 'resolved-cloud-cat': url, 'gpt-pro': 'https://chatgpt.com/c/another-member-conversation' };
  host.candidates = [candidate('complete-conversation-0123456789')];
  await render();
  const open = container.querySelector('a[target="_blank"]');
  expect(open?.getAttribute('href')).toBe(url);
  expect(open?.getAttribute('rel')).toBe('noopener noreferrer');
  expect(container.textContent).toContain('complete-conversation-0123456789');
  expect(container.querySelector('a[href^="/settings"]')).toBeNull();
  await act(async () =>
    container.querySelector<HTMLButtonElement>('button[aria-label="复制 ChatGPT 会话链接"]')?.click(),
  );
  expect(copy).toHaveBeenCalledWith(url);
  expect(container.textContent).toContain('已复制');
  await act(async () => buttonByText(container, '更换绑定')?.click());
  await flush();
  expect(container.querySelector('[data-route-chooser]')).not.toBeNull();
  expect(container.querySelector('input[type="radio"]')?.getAttribute('value')).toBe(
    'complete-conversation-0123456789',
  );
  expect(host.bindingReads()).toHaveLength(1);
  expect(host.patches()).toEqual([]);
});
it('compact cloud row keeps empty binding setup without fabricating a conversation', async () => {
  host.candidates = [];
  await render();
  expect(container.textContent).toContain('未绑定');
  expect(container.querySelector('a[target="_blank"]')?.getAttribute('href')).toBe('https://chatgpt.com/');
  expect(container.querySelector('a[href^="/settings"]')).toBeNull();
  expect(container.querySelector('button[aria-label="复制 ChatGPT 会话链接"]')).toBeNull();
  await act(async () => buttonByText(container, '选会话')?.click());
  await flush();
  expect(container.textContent).toContain('还没有已授权的会话');
  expect(container.querySelector('input[type="radio"]')).toBeNull();
  expect(host.patches()).toEqual([]);
});
it.each([
  401, 403,
])('compact cloud row hides actions after a %i binding read, even with authorized candidates', async (status) => {
  fetchMock.mockImplementation(async (path: string, init?: RequestInit, options?: unknown) =>
    path === host.bindingsPath
      ? jsonResponse({ error: 'denied' }, status)
      : (host.handle(path, init, options) ?? jsonResponse({ error: 'not found' }, 404)),
  );
  await render();
  expect(container.textContent).toContain('仅 thread owner 可见');
  expect(container.querySelector('a,button')).toBeNull();
  expect(host.patches()).toEqual([]);
});
it('compact cloud row never copies or opens an invalid stored URL', async () => {
  host.bindings = { 'gpt-pro': 'https://example.com/not-chatgpt' };
  await render();
  expect(container.textContent).toContain('绑定记录无效');
  expect(container.querySelector('a')?.getAttribute('href')).toBe('https://chatgpt.com/');
  expect(container.querySelector('button[aria-label="复制 ChatGPT 会话链接"]')).toBeNull();
  expect(buttonByText(container, '选会话')).toBeDefined();
});
it('compact cloud row stays absent when the Host cannot resolve one cloud member', async () => {
  host.cloudCat = { status: 'ambiguous' };
  host.bindings = { 'gpt-pro': 'https://chatgpt.com/c/must-not-infer-member' };
  await render();
  expect(container.querySelector('[data-testid="cloud-conversation-link"]')).toBeNull();
  expect(container.querySelector('a,button')).toBeNull();
  expect(host.patches()).toEqual([]);
});
