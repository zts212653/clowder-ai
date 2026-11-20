// @vitest-environment jsdom
import { WATCHER_CONFIG_DEFAULTS } from '@cat-cafe/shared';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const fetcher = vi.fn();
const update = vi.fn();
let threadState: Record<string, unknown>;
vi.mock('@/utils/api-client', () => ({ apiFetch: (...args: unknown[]) => fetcher(...args) }));
vi.mock('@/hooks/useWatcher', () => ({ useWatcher: () => ({ state: threadState, saving: false, update }) }));
vi.mock('@/hooks/useCatData', () => ({ useCatData: () => ({ getCatById: () => ({ nickname: '小太阳' }) }) }));

import { WatcherChip, WatcherThreadCard } from '../../watcher/WatcherThreadControls';
import { WatcherSettings } from '../WatcherSettings';

let root: Root, container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  threadState = {
    config: { ...WATCHER_CONFIG_DEFAULTS, memberCatId: 'codex61-sol', scope: 'selected' },
    control: { revision: 0 },
    enabled: false,
    rolloutEnabled: true,
    reviewing: false,
    memberName: '小太阳',
    capability: { supported: true },
  };
  fetcher.mockImplementation(async (url: string, init?: RequestInit) => {
    if (url.startsWith('/api/watcher/daily')) return { ok: true, json: async () => ({ rows: [], hasMore: false }) };
    return {
      ok: true,
      json: async () => ({
        config: {
          ...WATCHER_CONFIG_DEFAULTS,
          scope: 'selected',
          ...(init?.method === 'PUT' ? JSON.parse(String(init.body)) : {}),
        },
        quietLabels: [],
        availableLabels: [],
        members: [],
        rolloutEnabled: true,
      }),
    };
  });
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  fetcher.mockReset();
  update.mockReset();
  vi.unstubAllGlobals();
});

it('shows global routing instead of the retired per-thread scope selector without changing saved data', async () => {
  await act(async () => {
    root.render(<WatcherSettings />);
  });
  expect(container.querySelector('[aria-label="守望哪些对话"]')).toBeNull();
  expect(container.querySelector('[aria-label="主守望猫"]')).not.toBeNull();
  expect(fetcher.mock.calls.some(([, init]) => init?.method === 'PUT')).toBe(false);
});

it('leaves an unselected thread switch off and omits its chip, then opts in explicitly', async () => {
  act(() =>
    root.render(
      <>
        <WatcherThreadCard threadId="thread" />
        <WatcherChip threadId="thread" />
      </>,
    ),
  );
  const toggle = container.querySelector('[role="switch"]');
  expect(toggle?.getAttribute('aria-checked')).toBe('false');
  expect(toggle?.textContent).toContain('守望这条对话');
  expect(container.querySelector('[data-testid="watcher-chip"]')).toBeNull();
  act(() => (toggle as HTMLButtonElement).click());
  expect(update).toHaveBeenCalledExactlyOnceWith({ enabled: true });
  threadState = { ...threadState, control: { revision: 1, enabled: true }, enabled: true, reviewing: true };
  act(() =>
    root.render(
      <>
        <WatcherThreadCard threadId="thread" />
        <WatcherChip threadId="thread" />
      </>,
    ),
  );
  expect(container.querySelector('[data-testid="watcher-chip"]')?.textContent).toContain('小太阳');
  expect(container.querySelector('[data-testid="watcher-chip"]')?.textContent).toContain('查看中');
});
