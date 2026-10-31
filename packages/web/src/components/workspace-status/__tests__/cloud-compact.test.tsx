import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CloudConversationLink } from '@/components/CloudConversationLink';

const fetchMock = vi.hoisted(() => vi.fn());
vi.mock('@/utils/api-client', () => ({ apiFetch: (...args: unknown[]) => fetchMock(...args) }));
let container: HTMLDivElement;
let root: Root;
let clipboard: PropertyDescriptor | undefined;
beforeEach(() => {
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
});
it('compact cloud row keeps validated full URL copy/open and settings actions', async () => {
  const url = 'https://chatgpt.com/c/complete-conversation-0123456789';
  const copy = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: copy } });
  fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ bindings: { 'gpt-pro': url } }) });
  await act(async () => root.render(<CloudConversationLink threadId="compact-thread" compact />));
  expect(container.querySelector('a[target="_blank"]')?.getAttribute('href')).toBe(url);
  expect(container.querySelector('code')?.textContent).toBe('complete-conversation-0123456789');
  expect(container.querySelector('a[href^="/settings"]')?.getAttribute('href')).toContain('threadId=compact-thread');
  await act(async () => container.querySelector<HTMLButtonElement>('button')?.click());
  expect(copy).toHaveBeenCalledWith(url);
  expect(container.textContent).toContain('已复制');
});
it('compact cloud row keeps empty binding setup without fabricating a conversation', async () => {
  fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ bindings: {} }) });
  await act(async () => root.render(<CloudConversationLink threadId="compact-thread" compact />));
  expect(container.textContent).toContain('未绑定');
  expect(container.querySelector('a[target="_blank"]')?.getAttribute('href')).toBe('https://chatgpt.com/');
  expect(container.querySelector('a[href^="/settings"]')).not.toBeNull();
  expect(container.querySelector('button')).toBeNull();
});
it('compact cloud row does not expose actions after a denied binding read', async () => {
  fetchMock.mockResolvedValue({ ok: false, status: 403 });
  await act(async () => root.render(<CloudConversationLink threadId="compact-thread" compact />));
  expect(container.textContent).toContain('仅 thread owner 可见');
  expect(container.querySelector('a,button')).toBeNull();
});
