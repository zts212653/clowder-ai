// @vitest-environment jsdom
import { WATCHER_PANEL_DEFAULTS } from '@cat-cafe/shared';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const fetcher = vi.fn();
vi.mock('@/utils/api-client', () => ({ apiFetch: (...args: unknown[]) => fetcher(...args) }));

import { WatcherPanelReveal } from '../../watcher/WatcherPanelReveal';
import { WatcherPanelSettings } from '../WatcherPanelSettings';

let root: Root, container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  fetcher.mockReset();
});

const members = [
  { catId: 'codex61-terra', displayName: '小团团', panelSupported: true },
  { catId: 'codex61-sol', displayName: '小太阳', panelSupported: true },
  { catId: 'codex-astra', displayName: '小星星', panelSupported: true },
  { catId: 'opus55', displayName: '宪宪', panelSupported: false },
];

it('is off by default and offers only members that can watch as a panel', () => {
  const onSave = vi.fn();
  act(() =>
    root.render(
      <WatcherPanelSettings
        choices={{ panelDefaults: WATCHER_PANEL_DEFAULTS, panelAccounts: [], members }}
        disabled={false}
        onSave={onSave}
      />,
    ),
  );
  expect(container.querySelectorAll('input[type="checkbox"]:checked')).toHaveLength(0);
  expect(container.querySelector('[aria-label="小星星 用的账号"]')).toBeNull();
  const toggle = container.querySelector<HTMLButtonElement>('[role="switch"][aria-label="多只守望开关"]')!;
  expect(toggle.getAttribute('aria-checked')).toBe('false');
  expect(container.textContent).toContain('已关闭');
  expect(container.querySelector('[aria-label="守望成员 宪宪"]')).toBeNull();
  act(() => toggle.click());
  expect(onSave).toHaveBeenCalledWith({ panel: { ...WATCHER_PANEL_DEFAULTS, enabled: true } });
});

it('hides disabled saved members without losing their account or concurrency choices', () => {
  const onSave = vi.fn();
  const panel = {
    enabled: false,
    members: [{ catId: 'codex-astra', accountRef: 'backup-1' }],
    maxConcurrentRuns: 2,
  };
  act(() =>
    root.render(
      <WatcherPanelSettings
        choices={{ panel, panelDefaults: WATCHER_PANEL_DEFAULTS, panelAccounts: [], members }}
        disabled={false}
        onSave={onSave}
      />,
    ),
  );
  expect(container.querySelectorAll('input[type="checkbox"]')).toHaveLength(0);
  act(() => container.querySelector<HTMLButtonElement>('[role="switch"]')!.click());
  expect(onSave).toHaveBeenCalledWith({ panel: { ...panel, enabled: true } });
});

it('binds a member to a backup account without touching the others', () => {
  const onSave = vi.fn();
  const panel = { ...WATCHER_PANEL_DEFAULTS, enabled: true };
  act(() =>
    root.render(
      <WatcherPanelSettings
        choices={{
          panel,
          panelDefaults: WATCHER_PANEL_DEFAULTS,
          panelAccounts: [{ id: 'backup-1', label: '备用一' }],
          members,
        }}
        disabled={false}
        onSave={onSave}
      />,
    ),
  );
  const select = container.querySelector<HTMLSelectElement>('[aria-label="小星星 用的账号"]')!;
  act(() => {
    select.value = 'backup-1';
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  expect(onSave.mock.calls[0]![0].panel.members).toEqual([
    { catId: 'codex61-terra' },
    { catId: 'codex61-sol' },
    { catId: 'codex-astra', accountRef: 'backup-1' },
  ]);
});

it('names the members of a round only when the person asks', async () => {
  fetcher.mockResolvedValue({
    ok: true,
    json: async () => ({
      members: [
        { catId: 'codex-astra', label: '乙', status: 'quiet' },
        { catId: 'codex61-terra', label: '甲', status: 'spoke' },
      ],
    }),
  });
  const cats = { 'codex-astra': { nickname: '小星星' }, 'codex61-terra': { nickname: '小团团' } } as Record<
    string,
    { nickname: string }
  >;
  act(() => root.render(<WatcherPanelReveal roundId="wpr:x" getCatById={(id) => cats[id] as never} />));
  expect(container.textContent).not.toContain('小团团');
  await act(async () => container.querySelector('button')!.click());
  expect(fetcher).toHaveBeenCalledWith('/api/watcher/panel/rounds/wpr%3Ax');
  expect(container.textContent).toBe('甲：小团团（说了） · 乙：小星星（没说）');
});
