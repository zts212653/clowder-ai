import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));
vi.mock('@/hooks/useCatData', () => ({
  useCatData: () => ({
    getCatById: (catId: string) =>
      catId === 'fable-5'
        ? {
            id: catId,
            displayName: '布偶猫',
            nickname: '宪宪',
            variantLabel: 'Fable 5',
            name: 'Xianxian',
            breed: 'ragdoll',
            color: { primary: '#fff' },
          }
        : undefined,
  }),
}));

import {
  refreshConciergeDesktop,
  resetConciergeDesktopObservation,
  useConciergeDesktopStore,
} from '@/stores/conciergeDesktopStore';
import { useConciergeStore } from '@/stores/conciergeStore';
import { apiFetch } from '@/utils/api-client';
import { ConciergeDesktopFallbackNotice } from '../ConciergeDesktopFallbackNotice';

let container: HTMLDivElement;
let root: Root;
const fetch = vi.mocked(apiFetch);

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  window.sessionStorage.clear();
  resetConciergeDesktopObservation();
  useConciergeStore.setState({ dutyCatProfileId: 'fable-5' });
  fetch.mockReset();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  resetConciergeDesktopObservation();
  window.sessionStorage.clear();
  container.remove();
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});

it('uses the real Host show route and keeps the chosen partner through failure and observed recovery', async () => {
  act(() => root.render(<ConciergeDesktopFallbackNotice />));
  expect(container.textContent).toContain('宪宪');
  const button = [...container.querySelectorAll('button')].find((item) => item.textContent?.includes('重新打开'));
  if (!button) throw new Error('desktop recovery action is missing');

  fetch.mockResolvedValueOnce({ ok: false } as Response);
  await act(async () => button.click());
  expect(fetch).toHaveBeenCalledWith('/api/concierge/desktop/show', expect.objectContaining({ method: 'POST' }));
  expect(useConciergeDesktopStore.getState().visible).toBe(false);
  expect(container.textContent).toContain('未能重新打开');
  expect(container.textContent).not.toContain('已恢复');
  expect(container.textContent).toContain('宪宪');

  fetch.mockResolvedValueOnce({
    ok: true,
    json: async () => ({ presence: { state: 'visible', maxAgeMs: 15_000 } }),
  } as Response);
  await act(async () => button.click());
  expect(useConciergeDesktopStore.getState().visible).toBe(true);
  expect(container.textContent).toContain('桌面猫猫球已恢复');
  expect(container.textContent).toContain('宪宪');
});

it('offers a keyboard-focusable close action that only dismisses this failure notice', async () => {
  fetch.mockResolvedValueOnce({
    ok: true,
    json: async () => ({ presence: null, desktopLost: true, lossId: 'loss-A' }),
  } as Response);
  await act(async () => {
    await refreshConciergeDesktop();
  });
  act(() => root.render(<ConciergeDesktopFallbackNotice />));
  const close = container.querySelector<HTMLButtonElement>('button[aria-label="关闭桌面失联提示"]');
  expect(close).not.toBeNull();
  act(() => close?.focus());
  expect(document.activeElement).toBe(close);
  act(() => close?.click());
  expect(useConciergeDesktopStore.getState()).toMatchObject({
    visible: false,
    desktopLost: true,
    lossId: 'loss-A',
    noticeVisible: false,
  });
  expect(fetch).toHaveBeenCalledTimes(1);
});
