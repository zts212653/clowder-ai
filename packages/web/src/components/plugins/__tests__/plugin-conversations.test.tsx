import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { PluginConversationEntries } from '../PluginConversationEntries';

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock('@/utils/api-client', () => ({ apiFetch }));
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  apiFetch.mockReset();
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it('an installed setup entry leads to the original plugin settings', async () => {
  apiFetch.mockResolvedValue(
    Response.json({
      entries: [
        {
          pluginId: 'dev.resident',
          instanceId: 'installed',
          commandId: 'main',
          label: '我的助手',
          threadId: null,
          status: 'disabled',
          badgeCount: 0,
          order: 0,
        },
      ],
    }),
  );
  await act(async () => root.render(<PluginConversationEntries onSelect={vi.fn()} />));
  const link = container.querySelector('a');
  expect(link?.getAttribute('href')).toBe('/settings?s=plugins&plugin=dev.resident');
  expect(container.textContent).toContain('未启用');
});

it('the live entry selects its existing conversation and displays canonical unread', async () => {
  apiFetch.mockResolvedValue(
    Response.json({
      entries: [
        {
          pluginId: 'dev.resident',
          instanceId: 'installed',
          commandId: 'main',
          label: '我的助手',
          threadId: 'bot-main',
          status: 'listening',
          badgeCount: 2,
          order: 0,
        },
      ],
    }),
  );
  const select = vi.fn();
  await act(async () =>
    root.render(
      <PluginConversationEntries
        onSelect={select}
        currentThreadId="bot-main"
        unreadCounts={new Map([['bot-main', 2]])}
      />,
    ),
  );
  const button = container.querySelector('button');
  expect(button?.getAttribute('aria-current')).toBe('page');
  await act(async () => button?.click());
  expect(select).toHaveBeenCalledWith('bot-main');
  expect(container.querySelector('[aria-label="2 条未读"]')).not.toBeNull();
  expect(container.querySelector('[aria-label="我的助手设置"]')?.getAttribute('title')).toBe('我的助手设置');
});

it('shows live main-conversation unread without counting internal activity or outstanding questions', async () => {
  apiFetch.mockResolvedValue(
    Response.json({
      entries: [
        {
          pluginId: 'dev.resident',
          instanceId: 'installed',
          commandId: 'main',
          label: '我的助手',
          threadId: 'bot-main',
          status: 'ready',
          badgeCount: 7,
        },
      ],
    }),
  );
  const select = vi.fn();
  await act(async () =>
    root.render(
      <PluginConversationEntries
        onSelect={select}
        unreadCounts={
          new Map([
            ['bot-main', 3],
            ['bot-internal', 8],
          ])
        }
      />,
    ),
  );
  expect(container.querySelector('[aria-label="3 条未读"]')).not.toBeNull();
  expect(container.querySelector('[aria-label="7 项待处理"]')).toBeNull();
  await act(async () => container.querySelector('button')?.click());
  expect(select).toHaveBeenCalledWith('bot-main');
  await act(async () =>
    root.render(
      <PluginConversationEntries
        onSelect={select}
        unreadCounts={
          new Map([
            ['bot-main', 0],
            ['bot-internal', 9],
          ])
        }
      />,
    ),
  );
  expect(container.querySelector('[aria-label="3 条未读"]')).toBeNull();
  expect(apiFetch).toHaveBeenCalledTimes(1);
});

it('a temporary read failure preserves the previously confirmed native navigation', async () => {
  apiFetch.mockResolvedValueOnce(
    Response.json({
      entries: [
        {
          pluginId: 'dev.resident',
          instanceId: 'installed',
          commandId: 'main',
          label: '我的助手',
          threadId: 'bot-main',
          status: 'listening',
          badgeCount: 0,
        },
      ],
    }),
  );
  const select = vi.fn();
  await act(async () => root.render(<PluginConversationEntries onSelect={select} />));
  apiFetch.mockRejectedValueOnce(new Error('temporary network error'));
  await act(async () => window.dispatchEvent(new Event('focus')));
  const button = container.querySelector('button');
  expect(button).not.toBeNull();
  await act(async () => button?.click());
  expect(select).toHaveBeenCalledWith('bot-main');
});

it('resolves an unbound native target only after an explicit click and reports it for deduplication', async () => {
  const entry = {
    pluginId: 'dev.resident',
    instanceId: 'installed',
    commandId: 'main',
    label: '我的助手',
    threadId: null,
    status: 'ready',
    openable: true,
  };
  apiFetch.mockResolvedValueOnce(Response.json({ entries: [entry] }));
  const select = vi.fn();
  const confirmed = vi.fn();
  await act(async () => root.render(<PluginConversationEntries onSelect={select} onThreadsChange={confirmed} />));
  expect(apiFetch).toHaveBeenCalledTimes(1);
  apiFetch.mockResolvedValueOnce(Response.json({ entry: { ...entry, threadId: 'bot-main' } }));
  await act(async () => container.querySelector('button')?.click());
  expect(apiFetch).toHaveBeenLastCalledWith('/api/plugin-conversations/installed/main/open', { method: 'POST' });
  expect(select).toHaveBeenCalledWith('bot-main');
  expect(confirmed).toHaveBeenLastCalledWith(['bot-main']);
  await act(async () => container.querySelector('button')?.click());
  expect(apiFetch).toHaveBeenCalledTimes(2);
});

it('does not poll commands or entries while the window stays open', async () => {
  vi.useFakeTimers();
  apiFetch.mockResolvedValue(Response.json({ entries: [] }));
  await act(async () => root.render(<PluginConversationEntries onSelect={vi.fn()} />));
  await act(async () => vi.advanceTimersByTime(45_000));
  expect(apiFetch).toHaveBeenCalledTimes(1);
});
