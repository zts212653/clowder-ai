import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { ArtifactDownloadMenu } from '../ArtifactDownloadMenu';

vi.mock('@/utils/api-client', () => ({ API_URL: 'http://api.test' }));
afterEach(() => vi.unstubAllGlobals());

it('retains browser navigation for a cross-origin file without requiring CORS, while site files retain authenticated downloads', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const fetcher = vi.fn().mockRejectedValue(new TypeError('CORS read denied'));
  vi.stubGlobal('fetch', fetcher);
  const host = document.createElement('div'),
    root = createRoot(host);
  let preventedByMenu: boolean | undefined;
  // Observe the menu's decision, then suppress jsdom navigation at the host.
  host.addEventListener('click', (event) => {
    preventedByMenu = event.defaultPrevented;
    event.preventDefault();
  });
  const artifact = { type: 'file' as const, name: '原件.pdf', catId: null, createdAt: 1, sourceMessageId: null };
  try {
    await act(async () =>
      root.render(<ArtifactDownloadMenu artifact={{ ...artifact, url: 'https://files.example.org/report.pdf' }} />),
    );
    const external = host.querySelector('a');
    expect(external?.href).toBe('https://files.example.org/report.pdf');
    await act(async () => external?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })));
    expect(preventedByMenu).toBe(false);
    expect(fetcher).not.toHaveBeenCalled();

    await act(async () => root.render(<ArtifactDownloadMenu artifact={{ ...artifact, url: '/uploads/report.pdf' }} />));
    await act(async () =>
      host.querySelector('a')?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })),
    );
    expect(preventedByMenu).toBe(true);
    expect(fetcher).toHaveBeenCalledWith('http://api.test/uploads/report.pdf', { credentials: 'include' });
    expect(host.querySelector('[role="alert"]')).not.toBeNull();
  } finally {
    await act(async () => root.unmount());
  }
});
