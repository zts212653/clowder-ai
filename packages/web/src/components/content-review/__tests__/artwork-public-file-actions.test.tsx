import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { CollectiveMediaSurface } from '@/components/collective/CollectiveMediaSurface';
import {
  mediaProjection,
  mediaRef,
} from '../../../../../collective-client/src/__tests__/collective-media-surface.fixture';

it('keeps shared artwork file actions on the Host media URL without a private review lookup', async () => {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  localStorage.setItem('cat-cafe:shell-presentation', 'v2');
  const fetch = vi
    .spyOn(globalThis, 'fetch')
    .mockImplementation(async () => new Response(JSON.stringify({ local: false })));
  try {
    await act(async () =>
      root.render(
        <CollectiveMediaSurface
          reference={mediaRef}
          rpc={async () => ({ kind: 'read', value: mediaProjection() })}
          onBack={() => {}}
        />,
      ),
    );
    const more = container.querySelector<HTMLButtonElement>('button[aria-label="作品更多操作"]');
    expect(more).not.toBeNull();
    await act(async () => more?.click());
    const original = container.querySelector<HTMLImageElement>('[data-testid="workspace-content-review-media"]');
    const link = container.querySelector<HTMLAnchorElement>('[role="menu"] a[target="_blank"]');
    expect(link?.href).toBe(original?.src);
    expect(link?.href).toContain('/api/plugins/collective-connector/');
    expect(fetch.mock.calls.some(([url]) => String(url).includes('/content-reviews/'))).toBe(false);
    expect(container.querySelector('[data-testid="workspace-media-chat-whole-work"]')).toBeNull();
    expect(container.querySelector('[data-testid="content-modification-entry"]')).toBeNull();
  } finally {
    await act(async () => root.unmount());
    container.remove();
    localStorage.clear();
    vi.restoreAllMocks();
  }
});
