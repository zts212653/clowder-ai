import React from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { CommunityPanel } from '@/components/CommunityPanel';
import { API_URL } from '@/utils/api-client';

vi.mock('@/hooks/useCatNameResolver', () => ({ useCatNameResolver: () => (id: string) => id }));

it('community reads use the direct API origin and session cookie, then show disabled errors honestly', async () => {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const observed: Array<{ url: string; credentials?: RequestCredentials }> = [];
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input);
    observed.push({ url, credentials: init?.credentials });
    if (url === `${API_URL}/api/session`) return Response.json({});
    if (url.startsWith(`${API_URL}/api/plugins/`))
      return Response.json({ error: 'Webhook path not found' }, { status: 404 });
    return Response.json({ error: 'Plugin read endpoint requires direct localhost Hub access' }, { status: 403 });
  });
  try {
    await React.act(async () => {
      root.render(<CommunityPanel />);
    });
    await vi.waitFor(() => expect(observed.some(({ url }) => url.endsWith('/community-repos'))).toBe(true));
    const pluginReads = observed.filter(({ url }) => url.includes('/api/plugins/'));
    expect(pluginReads.length).toBeGreaterThanOrEqual(2);
    for (const request of pluginReads) {
      expect(request.url.startsWith(`${API_URL}/api/plugins/`)).toBe(true);
      expect(request.credentials).toBe('include');
    }
    await vi.waitFor(() => expect(container.textContent).toContain('无法读取 PR 仓库，请检查 GitHub 插件是否已启用。'));
  } finally {
    await React.act(async () => root.unmount());
    container.remove();
    fetch.mockRestore();
  }
});
