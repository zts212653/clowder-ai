import type { SessionCacheWarmth } from '@cat-cafe/shared';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { SessionCacheStatus } from '../SessionCacheStatus';

it('shows only active maintenance warmth and removes the badge after opt-out or expiry', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(1_800_000_000_000);
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const warmth: SessionCacheWarmth = {
    status: 'warm',
    source: 'cache_retention',
    estimated: true,
    retaining: true,
    expiresAt: Date.now() + 20_000,
  };
  try {
    await act(async () => root.render(<SessionCacheStatus warmth={warmth} />));
    expect(host.textContent).toContain('缓存保留至');
    await act(async () => root.render(<SessionCacheStatus warmth={{ ...warmth, retaining: false }} />));
    expect(host.textContent).toBe('');
    await act(async () => root.render(<SessionCacheStatus warmth={warmth} />));
    await act(async () => {
      vi.advanceTimersByTime(30_000);
    });
    expect(host.textContent).toBe('');
  } finally {
    await act(async () => root.unmount());
    host.remove();
    vi.useRealTimers();
  }
});
