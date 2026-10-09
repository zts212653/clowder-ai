import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/utils/api-client', () => ({
  apiFetch: vi.fn(),
}));

import { apiFetch } from '@/utils/api-client';
import { PluginsContent } from '../settings/PluginsContent';

import { catalog, jsonResponse, managerResponse } from './plugin-manager-compat-fixture';

describe('PluginsContent — Manager plugin config', () => {
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

  it('does not invent a builtin GitHub row or fetch services when the Manager is empty', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ plugins: [], catalog }));
    await renderPluginsContent();
    expect(container.textContent).not.toContain('GitHub');
    expect(mockFetch.mock.calls.some(([path]) => path === '/api/services' || path === '/api/plugins')).toBe(false);
  });

  it('opens GitHub token configuration supplied by the generic Manager', async () => {
    mockFetch.mockImplementation(async (path: string) => managerResponse(path));
    await renderPluginsContent();
    const row = container.querySelector('[data-plugin-id="github"]');
    expect(row).toBeTruthy();
    await act(async () => row?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await vi.waitFor(() => expect(container.textContent).toContain('Personal Access Token'));
    expect(container.querySelector('#plugin-manager-github-GITHUB_TOKEN')).toBeTruthy();
  });
});
