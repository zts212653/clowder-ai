import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/utils/api-client', () => ({
  apiFetch: vi.fn(),
  API_URL: 'http://localhost:3102',
}));

import { apiFetch } from '@/utils/api-client';
import { PluginsContent } from '../settings/PluginsContent';

const mockApiFetch = vi.mocked(apiFetch);

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

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

  it('opens editable GitHub config fields and saves via connector path', async () => {
    mockApiFetch.mockImplementation(async (url, init) => {
      if (url === '/api/plugins') {
        return jsonResponse({
          plugins: [
            {
              id: 'github',
              name: 'GitHub',
              version: '1.0.0',
              icon: 'github',
              iconBg: '#24292e',
              status: 'configured',
              hasHealthCheck: false,
              config: [],
              resources: [],
            },
          ],
        });
      }
      if (url === '/api/connector/status') {
        return jsonResponse({
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
                {
                  envName: 'GITHUB_SETUP_NOISE_BOT_LOGINS',
                  label: 'Noise 过滤 Bot 列表',
                  sensitive: false,
                  currentValue: 'chatgpt-codex-connector[bot]',
                },
              ],
            },
          ],
        });
      }
      if (url === '/api/config/secrets' && init?.method === 'POST') {
        return jsonResponse({ ok: true });
      }
      return jsonResponse({}, 404);
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

    const tokenInput = container.querySelector('[data-testid="field-GITHUB_TOKEN"]') as HTMLInputElement | null;
    const noiseInput = container.querySelector(
      '[data-testid="field-GITHUB_SETUP_NOISE_BOT_LOGINS"]',
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
      button.textContent?.includes('保存 GitHub 配置'),
    );
    expect(save).toBeTruthy();

    await act(async () => {
      save?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushEffects();

    const saveCall = mockApiFetch.mock.calls.find((call) => call[0] === '/api/config/secrets');
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
});
