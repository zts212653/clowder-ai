import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/utils/api-client', () => ({
  apiFetch: vi.fn(),
  API_URL: 'http://localhost:3102',
}));

import { apiFetch } from '@/utils/api-client';
import { PluginsContent, resolvePluginStatuses } from '../settings/PluginsContent';

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

describe('resolvePluginStatuses', () => {
  it('platform plugins are active when API is reachable', () => {
    const result = resolvePluginStatuses([], true);
    const platform = result.filter((p) => p.source === 'platform');

    expect(platform.length).toBe(1);
    expect(platform[0].id).toBe('github');
    expect(platform[0].status).toBe('active');
    expect(platform[0].statusLabel).toBe('已连接');
  });

  it('platform plugins show unreachable when API is down', () => {
    const result = resolvePluginStatuses([], false);
    const platform = result.filter((p) => p.source === 'platform');

    for (const p of platform) {
      expect(p.status).toBe('available');
      expect(p.statusLabel).toBe('API 不可达');
    }
  });

  it('service plugins show active when their features are running', () => {
    const services = [
      {
        manifest: { id: 'whisper-stt', enablesFeatures: ['voice-input', 'connector-stt'] },
        status: 'running' as const,
      },
      {
        manifest: { id: 'mlx-tts', enablesFeatures: ['voice-output', 'voice-companion'] },
        status: 'running' as const,
      },
    ];
    const result = resolvePluginStatuses(services, true);
    const voice = result.find((p) => p.id === 'voice-companion');

    expect(voice?.status).toBe('active');
    expect(voice?.statusLabel).toBe('已连接');
  });

  it('service plugins show configured when features known but not running', () => {
    const services = [
      {
        manifest: { id: 'whisper-stt', enablesFeatures: ['voice-input', 'connector-stt'] },
        status: 'stopped' as const,
      },
    ];
    const result = resolvePluginStatuses(services, true);
    const voice = result.find((p) => p.id === 'voice-companion');

    expect(voice?.status).toBe('configured');
    expect(voice?.statusLabel).toBe('已配置');
  });

  it('service plugins show available when no matching features exist', () => {
    const result = resolvePluginStatuses([], true);
    const voice = result.find((p) => p.id === 'voice-companion');

    expect(voice?.status).toBe('available');
    expect(voice?.statusLabel).toBe('未连接');
  });

  it('platform status is independent of service registry contents', () => {
    const services = [
      {
        manifest: { id: 'whisper-stt', enablesFeatures: ['voice-input'] },
        status: 'running' as const,
      },
    ];
    const result = resolvePluginStatuses(services, true);

    const github = result.find((p) => p.id === 'github');
    expect(github?.status).toBe('active');
  });
});

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

  it('opens editable GitHub config fields and saves changed values', async () => {
    mockApiFetch.mockImplementation(async (url, init) => {
      if (url === '/api/services') {
        return jsonResponse({ services: [] });
      }
      if (url === '/api/connector/status') {
        return jsonResponse({
          platforms: [
            {
              id: 'github',
              category: 'plugin',
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
                {
                  envName: 'GITHUB_MCP_PAT',
                  label: 'MCP 专用 Token',
                  sensitive: true,
                  currentValue: null,
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
