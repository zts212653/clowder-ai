import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/utils/api-client', () => ({
  apiFetch: vi.fn(),
}));

vi.mock('../VoiceSettingsPanel', () => ({
  VoiceSettingsPanel: () => React.createElement('div', { 'data-testid': 'voice-settings-panel' }, 'Voice Settings'),
}));

import { apiFetch } from '@/utils/api-client';
import { ServiceStatusPanel } from '../settings/ServiceStatusPanel';
import { SettingsContent } from '../settings/SettingsContent';

const servicesPayload = {
  services: [
    {
      id: 'whisper-stt',
      name: 'Whisper STT',
      description: 'Local speech-to-text endpoint',
      category: 'voice',
      features: ['voice-input', 'connector-stt'],
      endpoint: 'http://localhost:9876',
      configured: true,
      status: 'healthy',
      httpStatus: 200,
      error: null,
      availableActions: [],
    },
    {
      id: 'embedding-model',
      name: 'Embedding Model',
      description: 'Semantic memory embedding endpoint',
      category: 'memory',
      features: ['memory-semantic-search'],
      endpoint: 'http://127.0.0.1:9880',
      configured: true,
      status: 'unhealthy',
      httpStatus: 503,
      error: 'HTTP 503',
      availableActions: [],
    },
  ],
};

describe('ServiceStatusPanel', () => {
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
      json: async () => servicesPayload,
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

  async function render(element: React.ReactElement) {
    await act(async () => {
      root.render(element);
    });
  }

  it('renders a filtered read-only service status panel', async () => {
    await render(React.createElement(ServiceStatusPanel, { filterFeatures: ['voice-input'], title: '语音服务' }));

    expect(mockFetch.mock.calls[0][0]).toBe('/api/services');
    expect(container.textContent).toContain('语音服务');
    expect(container.textContent).toContain('Whisper STT');
    expect(container.textContent).toContain('运行中');
    expect(container.textContent).not.toContain('Embedding Model');
    expect(container.textContent).not.toContain('启动');
    expect(container.textContent).not.toContain('停止');
    expect(container.textContent).not.toContain('安装');
    expect(container.textContent).not.toContain('卸载');
  });

  it('renders unhealthy service errors and endpoint metadata', async () => {
    await render(
      React.createElement(ServiceStatusPanel, { filterFeatures: ['memory-semantic-search'], title: '记忆服务' }),
    );

    expect(container.textContent).toContain('记忆服务');
    expect(container.textContent).toContain('Embedding Model');
    expect(container.textContent).toContain('异常');
    expect(container.textContent).toContain('http://127.0.0.1:9880');
    expect(container.textContent).toContain('HTTP 503');
    expect(container.textContent).not.toContain('Whisper STT');
  });

  it('renders nothing while the service request is pending', () => {
    mockFetch.mockReturnValue(new Promise(() => undefined));

    act(() => {
      root.render(React.createElement(ServiceStatusPanel, { filterFeatures: ['voice-input'], title: '语音服务' }));
    });

    expect(container.textContent).toBe('');
  });

  it('wires the voice settings section to the service status panel', async () => {
    await render(React.createElement(SettingsContent, { section: 'voice' }));

    expect(container.textContent).toContain('语音服务');
    expect(container.textContent).toContain('Whisper STT');
    expect(container.querySelector('[data-testid="voice-settings-panel"]')).toBeTruthy();
  });

  it('reads lines field from /logs DTO during install polling', async () => {
    const installablePayload = {
      services: [
        {
          id: 'mlx-tts',
          name: 'MLX TTS',
          description: 'Text to speech',
          category: 'voice',
          features: ['voice-output'],
          endpoint: null,
          configured: false,
          status: 'not_configured',
          error: null,
          availableActions: ['install'],
        },
      ],
    };

    let installResolve: (v: { ok: boolean; json: () => Promise<{ ok: boolean }> }) => void = () => {};
    mockFetch.mockImplementation(async (path: string) => {
      if (path === '/api/services') {
        return { ok: true, json: async () => installablePayload };
      }
      if (path === '/api/services/mlx-tts/logs') {
        return {
          ok: true,
          json: async () => ({ serviceId: 'mlx-tts', lines: ['Downloading model...', 'Installing deps...'] }),
        };
      }
      if (path === '/api/services/mlx-tts/install') {
        return new Promise((resolve) => {
          installResolve = resolve;
        });
      }
      return { ok: true, json: async () => ({}) };
    });

    await render(React.createElement(ServiceStatusPanel, { filterFeatures: ['voice-output'], title: 'TTS' }));

    const installBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'Install');
    expect(installBtn).toBeTruthy();

    await act(async () => {
      installBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    // Wait for log poll interval to fire (2s)
    await act(async () => {
      await new Promise((r) => setTimeout(r, 2100));
    });

    expect(container.textContent).toContain('Installing deps...');

    // Resolve install to clean up
    await act(async () => {
      installResolve({ ok: true, json: async () => ({ ok: true }) });
      await Promise.resolve();
    });
  });
});
