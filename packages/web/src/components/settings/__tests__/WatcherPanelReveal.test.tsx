// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const fetcher = vi.fn();
vi.mock('@/utils/api-client', () => ({ apiFetch: (...args: unknown[]) => fetcher(...args) }));

import { WatcherPanelReveal } from '../../watcher/WatcherPanelReveal';

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
