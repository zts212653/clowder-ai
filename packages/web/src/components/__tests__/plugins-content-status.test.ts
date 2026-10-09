import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/utils/api-client', () => ({
  apiFetch: vi.fn(),
  API_URL: 'http://localhost:3102',
}));

import { apiFetch } from '@/utils/api-client';
import { PluginsContent } from '../settings/PluginsContent';

import { github, jsonResponse, managerResponse } from './plugin-manager-compat-fixture';

const mockApiFetch = vi.mocked(apiFetch);

async function flushEffects() {
  await act(async () => {
    await Promise.resolve();
  });
}

function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('PluginsContent GitHub configuration', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterAll(() => {
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    mockApiFetch.mockReset();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  it('opens editable GitHub config fields and saves via plugin path', async () => {
    mockApiFetch.mockImplementation(async (url, init) => {
      if (url === '/api/plugins/github/config' && init?.method === 'POST') {
        return jsonResponse({ ok: true });
      }
      return managerResponse(String(url));
    });

    await act(async () => {
      root.render(React.createElement(PluginsContent));
    });
    await flushEffects();

    const githubButton = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('GitHub'),
    );
    expect(githubButton).toBeTruthy();

    await act(async () => {
      githubButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushEffects();

    const tokenInput = container.querySelector('#plugin-manager-github-GITHUB_TOKEN') as HTMLInputElement | null;
    const noiseInput = container.querySelector(
      '#plugin-manager-github-GITHUB_SETUP_NOISE_BOT_LOGINS',
    ) as HTMLInputElement | null;
    expect(tokenInput).toBeTruthy();
    expect(noiseInput).toBeTruthy();
    if (!tokenInput || !noiseInput) throw new Error('GitHub config inputs did not render');
    expect(noiseInput?.placeholder).toBe('chatgpt-codex-connector[bot]');

    await act(async () => {
      setInputValue(tokenInput, 'ghp_new');
      setInputValue(noiseInput, 'chatgpt-codex-connector[bot],github-actions[bot]');
    });

    const save = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('保存配置'),
    );
    expect(save).toBeTruthy();

    await act(async () => {
      save?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushEffects();

    const saveCall = mockApiFetch.mock.calls.find((call) => call[0] === '/api/plugins/github/config');
    expect(saveCall).toBeTruthy();
    expect(JSON.parse((saveCall?.[1] as { body: string }).body)).toEqual({
      updates: [
        { name: 'GITHUB_TOKEN', value: 'ghp_new' },
        {
          name: 'GITHUB_SETUP_NOISE_BOT_LOGINS',
          value: 'chatgpt-codex-connector[bot],github-actions[bot]',
        },
      ],
    });
  });

  it('keeps the disable toggle visible for enabled plugins after config is removed', async () => {
    const plugin = {
      ...github,
      pluginId: 'fixture-plugin',
      displayName: 'Fixture Plugin',
      source: { kind: 'local-archive' as const, packageName: 'fixture-plugin', trust: 'local-trusted' as const },
      config: 'incomplete' as const,
      intent: 'enabled' as const,
      live: 'crashed' as const,
      configFields: [],
    };
    mockApiFetch.mockImplementation(async (url, init) => {
      if (url === '/api/plugin-manager/plugins/fixture-plugin/set-enabled' && init?.method === 'POST') {
        return jsonResponse({ ok: true });
      }
      return managerResponse(String(url), plugin);
    });

    await act(async () => {
      root.render(React.createElement(PluginsContent));
    });
    await flushEffects();

    const disableToggle = container.querySelector('button[aria-label="禁用Fixture Plugin"]');
    expect(disableToggle).toBeTruthy();
    expect(disableToggle?.parentElement?.closest('button')).toBeNull();

    await act(async () => {
      disableToggle?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushEffects();

    const call = mockApiFetch.mock.calls.find(
      ([path]) => path === '/api/plugin-manager/plugins/fixture-plugin/set-enabled',
    );
    expect(call).toBeTruthy();
    expect(JSON.parse((call?.[1] as { body: string }).body)).toEqual({ enabled: false, expectedRevision: 1 });
  });
});
