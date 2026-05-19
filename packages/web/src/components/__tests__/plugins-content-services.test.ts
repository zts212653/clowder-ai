import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/utils/api-client', () => ({
  apiFetch: vi.fn(),
}));

import { apiFetch } from '@/utils/api-client';
import { PluginsContent } from '../settings/PluginsContent';

describe('PluginsContent service manifest view', () => {
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
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        services: [
          {
            id: 'whisper-stt',
            name: 'Whisper STT',
            description: 'Local speech-to-text endpoint',
            endpoint: 'http://127.0.0.1:9876/health',
            configured: true,
            status: 'healthy',
            features: ['voice-input'],
            availableActions: [],
          },
          {
            id: 'mlx-tts',
            name: 'MLX TTS',
            description: 'Local text-to-speech endpoint',
            endpoint: null,
            configured: false,
            status: 'not_configured',
            features: ['voice-output'],
            availableActions: [],
          },
        ],
      }),
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

  it('renders service manifest status without lifecycle action buttons', async () => {
    await renderPluginsContent();

    expect(mockFetch.mock.calls[0][0]).toBe('/api/services');
    expect(container.textContent).toContain('Whisper STT');
    expect(container.textContent).toContain('运行中');
    expect(container.textContent).toContain('MLX TTS');
    expect(container.textContent).toContain('可安装');
    const buttons = Array.from(container.querySelectorAll('button'));
    const actionLabels = ['Install', 'Start', 'Stop', 'Uninstall'];
    for (const label of actionLabels) {
      expect(buttons.some((b) => b.textContent === label)).toBe(false);
    }
  });

  it('renders expandable GitHub token config on the plugins page', async () => {
    mockFetch.mockImplementation(async (path: string) => {
      if (path === '/api/services') {
        return {
          ok: true,
          json: async () => ({ services: [] }),
        };
      }
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

  it('renders loading state while the service manifest request is pending', () => {
    mockFetch.mockReturnValue(new Promise(() => undefined));

    act(() => {
      root.render(React.createElement(PluginsContent));
    });

    expect(container.textContent).toContain('加载中...');
  });

  it('does not process service payloads after unmount', async () => {
    let resolveFetch: (value: { ok: true; json: () => Promise<{ services: unknown[] }> }) => void = () => {};
    const json = vi.fn(async () => ({ services: [] }));
    mockFetch.mockReturnValue(
      new Promise((resolve) => {
        resolveFetch = resolve;
      }),
    );

    act(() => {
      root.render(React.createElement(PluginsContent));
    });
    act(() => root.unmount());

    await act(async () => {
      resolveFetch({ ok: true, json });
      await Promise.resolve();
    });

    expect(json).not.toHaveBeenCalled();
  });

  it('renders service manifest load errors', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 503,
    });

    await renderPluginsContent();

    expect(container.textContent).toContain('服务清单加载失败 (503)');
  });

  it('keeps GitHub token config reachable when the service manifest fails', async () => {
    mockFetch.mockImplementation(async (path: string) => {
      if (path === '/api/services') {
        return {
          ok: false,
          status: 503,
        };
      }
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

    expect(container.textContent).toContain('服务清单加载失败 (503)');
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

  it('renders unhealthy service probe errors', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        services: [
          {
            id: 'whisper-stt',
            name: 'Whisper STT',
            description: 'Local speech-to-text endpoint',
            endpoint: 'http://127.0.0.1:9876/health',
            configured: true,
            status: 'unhealthy',
            features: ['voice-input'],
            availableActions: [],
            error: 'HTTP 503',
          },
        ],
      }),
    });

    await renderPluginsContent();

    expect(container.textContent).toContain('Whisper STT');
    expect(container.textContent).toContain('已安装');
    expect(container.textContent).toContain('HTTP 503');
  });
});
