import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/utils/api-client', () => ({
  apiFetch: vi.fn(),
}));

import { apiFetch } from '@/utils/api-client';
import { PluginsContent } from '../settings/PluginsContent';

describe('PluginsContent — GitHub plugin config', () => {
  let container: HTMLDivElement;
  let root: Root;
  const mockFetch = apiFetch as ReturnType<typeof vi.fn>;

  beforeAll(() => {
    (globalThis as { React?: typeof React }).React = React;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    mockFetch.mockReset();
    mockFetch.mockImplementation(async () => {
      return { ok: true, json: async () => ({ ok: true }) };
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  afterAll(() => {
    delete (globalThis as { React?: typeof React }).React;
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  function renderPluginsContent() {
    return act(async () => {
      root.render(React.createElement(PluginsContent));
    });
  }

  it('renders GitHub plugin without fetching services', async () => {
    await renderPluginsContent();

    expect(container.textContent).toContain('GitHub');
    expect(container.textContent).toContain('内置插件');
    expect(mockFetch).not.toHaveBeenCalledWith('/api/services');
  });

  it('renders expandable GitHub token config', async () => {
    mockFetch.mockImplementation(async (path: string) => {
      if (path === '/api/connector/status') {
        return {
          ok: true,
          json: async () => ({
            platforms: [
              {
                id: 'github',
                fields: [
                  {
                    envName: 'GITHUB_TOKEN',
                    label: 'Personal Access Token',
                    sensitive: true,
                    currentValue: null,
                  },
                ],
              },
            ],
          }),
        };
      }
      return { ok: true, json: async () => ({ ok: true }) };
    });

    await renderPluginsContent();

    const githubButton = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('GitHub'),
    );
    expect(githubButton).toBeTruthy();

    await act(async () => {
      githubButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(container.textContent).toContain('Personal Access Token');
    expect(container.querySelector('input[name="GITHUB_TOKEN"]')).toBeTruthy();
  });
});
