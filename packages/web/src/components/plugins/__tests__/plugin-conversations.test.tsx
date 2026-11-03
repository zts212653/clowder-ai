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

it('the live entry selects its existing conversation and displays only the supplied attention count', async () => {
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
  await act(async () => root.render(<PluginConversationEntries onSelect={select} currentThreadId="bot-main" />));
  const button = container.querySelector('button');
  expect(button?.getAttribute('aria-current')).toBe('page');
  await act(async () => button?.click());
  expect(select).toHaveBeenCalledWith('bot-main');
  expect(container.querySelector('[aria-label="2 项待处理"]')).not.toBeNull();
});
