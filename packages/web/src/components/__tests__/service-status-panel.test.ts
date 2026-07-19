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
      installed: true,
      enabled: true,
      installable: true,
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
      installed: true,
      enabled: true,
      selectedModel: 'mlx-community/Qwen3-Embedding-0.6B-4bit-DWQ',
      installable: true,
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
    await render(
      React.createElement(ServiceStatusPanel, {
        filterFeatures: ['voice-input'],
        title: '语音服务',
        anchorId: 'voice-service-controls',
      }),
    );

    expect(mockFetch.mock.calls[0][0]).toBe('/api/services');
    expect(container.textContent).toContain('语音服务');
    expect(container.textContent).toContain('语音识别 (Whisper)');
    expect(container.textContent).toContain('运行中');
    expect(container.textContent).not.toContain('嵌入模型');
    expect(container.textContent).not.toContain('启动');
    expect(container.textContent).not.toContain('停止');
    expect(container.textContent).not.toContain('安装');
    expect(container.textContent).not.toContain('卸载');
    expect(container.querySelector('#voice-service-controls')).toBeTruthy();
  });

  it('renders unhealthy service errors and endpoint metadata', async () => {
    await render(
      React.createElement(ServiceStatusPanel, { filterFeatures: ['memory-semantic-search'], title: '记忆服务' }),
    );

    expect(container.textContent).toContain('记忆服务');
    expect(container.textContent).toContain('嵌入模型');
    expect(container.textContent).toContain('异常');
    expect(container.textContent).toContain('mlx-community/Qwen3-Embedding-0.6B-4bit-DWQ');
    expect(container.textContent).toContain('http://127.0.0.1:9880');
    expect(container.textContent).toContain('HTTP 503');
    expect(container.textContent).not.toContain('语音识别 (Whisper)');
  });

  it('shows a 修改 button next to trash when service is installed and disabled', async () => {
    const stoppedPayload = {
      services: [
        {
          id: 'whisper-stt',
          name: 'Whisper STT',
          description: 'Local speech-to-text endpoint',
          category: 'voice',
          features: ['voice-input'],
          endpoint: 'http://localhost:19876',
          configured: true,
          status: 'unhealthy',
          httpStatus: null,
          error: null,
          installed: true,
          enabled: false,
          selectedModel: 'mlx-community/whisper-large-v3-turbo',
          port: 19876,
          installable: true,
        },
      ],
    };
    mockFetch.mockResolvedValue({ ok: true, json: async () => stoppedPayload });

    await render(React.createElement(ServiceStatusPanel, { filterFeatures: ['voice-input'], title: '语音服务' }));

    const reconfigureBtn = Array.from(container.querySelectorAll('button')).find((b) => b.title === '修改端口或模型');
    expect(reconfigureBtn).toBeTruthy();
    const trashBtn = Array.from(container.querySelectorAll('button')).find((b) => b.title === '卸载');
    expect(trashBtn).toBeTruthy();
  });

  it('hides the 修改 button when service is enabled', async () => {
    await render(React.createElement(ServiceStatusPanel, { filterFeatures: ['voice-input'], title: '语音服务' }));

    const reconfigureBtn = Array.from(container.querySelectorAll('button')).find((b) => b.title === '修改端口或模型');
    expect(reconfigureBtn).toBeFalsy();
  });

  it('does not call /reconfigure until the modal is confirmed', async () => {
    const stoppedPayload = {
      services: [
        {
          id: 'whisper-stt',
          name: 'Whisper STT',
          description: 'Local speech-to-text endpoint',
          category: 'voice',
          features: ['voice-input'],
          endpoint: 'http://localhost:19876',
          configured: true,
          status: 'unhealthy',
          httpStatus: null,
          error: null,
          installed: true,
          enabled: false,
          selectedModel: 'mlx-community/whisper-large-v3-turbo',
          port: 19876,
          installable: true,
        },
      ],
    };
    const calls: string[] = [];
    mockFetch.mockImplementation(async (path: string) => {
      calls.push(path);
      if (path === '/api/services') return { ok: true, json: async () => stoppedPayload };
      return { ok: true, json: async () => ({}) };
    });

    await render(React.createElement(ServiceStatusPanel, { filterFeatures: ['voice-input'], title: '语音服务' }));

    const reconfigureBtn = Array.from(container.querySelectorAll('button')).find(
      (b) => b.title === '修改端口或模型',
    ) as HTMLButtonElement;
    expect(reconfigureBtn).toBeTruthy();

    await act(async () => {
      reconfigureBtn.click();
    });

    expect(calls.some((p) => p.includes('/reconfigure'))).toBe(false);
    expect(calls.some((p) => p.includes('install-preview'))).toBe(true);
  });

  it('shows toggle ON and no trash for enabled+unhealthy service', async () => {
    const unhealthyEnabledPayload = {
      services: [
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
          installed: true,
          enabled: true,
          installable: true,
        },
      ],
    };
    mockFetch.mockResolvedValue({ ok: true, json: async () => unhealthyEnabledPayload });

    await render(
      React.createElement(ServiceStatusPanel, { filterFeatures: ['memory-semantic-search'], title: '记忆服务' }),
    );

    const toggle = container.querySelector('.settings-resource-toggle') as HTMLButtonElement;
    expect(toggle).toBeTruthy();
    expect(toggle.title).toBe('停止服务');
    expect(toggle.className).toContain('cafe-accent');

    const trashBtn = Array.from(container.querySelectorAll('button')).find((b) => b.title === '卸载');
    expect(trashBtn).toBeFalsy();
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
    expect(container.textContent).toContain('语音识别 (Whisper)');
    expect(container.querySelector('[data-testid="voice-settings-panel"]')).toBeTruthy();
  });

  it('shows error and does not call /toggle when /stop fails', async () => {
    const enabledPayload = {
      services: [
        {
          id: 'whisper-stt',
          name: 'Whisper STT',
          description: 'Local speech-to-text endpoint',
          category: 'voice',
          features: ['voice-input'],
          endpoint: 'http://localhost:9876',
          configured: true,
          status: 'healthy',
          httpStatus: 200,
          error: null,
          installed: true,
          enabled: true,
          installable: true,
        },
      ],
    };
    const callLog: string[] = [];
    mockFetch.mockImplementation(async (path: string) => {
      callLog.push(path);
      if (path === '/api/services') {
        return { ok: true, json: async () => enabledPayload };
      }
      if (path.includes('/stop')) {
        return { ok: true, json: async () => ({ ok: false, error: 'Stop failed: process busy' }) };
      }
      return { ok: true, json: async () => ({ ok: true }) };
    });

    await render(React.createElement(ServiceStatusPanel, { filterFeatures: ['voice-input'], title: '语音服务' }));

    const toggle = container.querySelector('.settings-resource-toggle') as HTMLButtonElement;
    expect(toggle).toBeTruthy();

    await act(async () => {
      toggle.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(callLog.some((p) => p.includes('/stop'))).toBe(true);
    expect(callLog.some((p) => p.includes('/toggle'))).toBe(false);
    expect(container.textContent).toContain('Stop failed: process busy');
  });

  it('surfaces lifecycle output when install fails', async () => {
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
          installed: false,
          enabled: false,
          installable: true,
        },
      ],
    };
    mockFetch.mockImplementation(async (path: string) => {
      if (path === '/api/services') {
        return { ok: true, json: async () => installablePayload };
      }
      if (path === '/api/services/mlx-tts/install') {
        return {
          ok: false,
          json: async () => ({
            ok: false,
            error: 'install script failed (exit 1)',
            output: 'Failed to install TTS dependencies',
          }),
        };
      }
      return { ok: true, json: async () => ({}) };
    });

    await render(React.createElement(ServiceStatusPanel, { filterFeatures: ['voice-output'], title: 'TTS' }));

    const installBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === '安装');
    expect(installBtn).toBeTruthy();

    await act(async () => {
      installBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(container.textContent).toContain('install script failed (exit 1)');
    expect(container.textContent).toContain('Failed to install TTS dependencies');
  });

  it('opens install preview for no-model scripted services before installing', async () => {
    const profile = {
      os: 'win32',
      arch: 'x64',
      gpu: 'none',
      pythonArch: 'native',
      pythonVersion: '3.12',
      ramGb: 16,
      diskFreeGb: 80,
      detectedAt: Date.now(),
    };
    const installablePayload = {
      services: [
        {
          id: 'audio-capture',
          name: 'Audio Capture',
          description: 'System audio capture',
          category: 'audio',
          features: ['voice-input'],
          endpoint: null,
          configured: false,
          status: 'not_configured',
          error: null,
          installed: false,
          enabled: false,
          installable: true,
          prerequisites: {
            runtime: 'python3.10+',
            packages: ['sounddevice', 'fastapi', 'uvicorn', 'numpy'],
            models: [],
            estimatedMinutes: 2,
          },
        },
      ],
    };
    const callLog: string[] = [];
    mockFetch.mockImplementation(async (path: string, init?: RequestInit) => {
      callLog.push(`${path}:${init?.body ?? ''}`);
      if (path === '/api/services') {
        return { ok: true, json: async () => installablePayload };
      }
      if (path === '/api/services/audio-capture/install-preview') {
        return {
          ok: true,
          json: async () => ({
            profile,
            suggestedPort: 19981,
            recommendation: {
              serviceId: 'audio-capture',
              profile,
              models: [],
              notes: ['Windows: sounddevice uses WASAPI / DirectSound, no extra model download.'],
            },
          }),
        };
      }
      if (path === '/api/services/audio-capture/install') {
        return { ok: true, json: async () => ({ ok: true }) };
      }
      return { ok: true, json: async () => ({}) };
    });

    await render(React.createElement(ServiceStatusPanel, { filterFeatures: ['voice-input'], title: '音频' }));

    const installBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === '安装');
    expect(installBtn).toBeTruthy();

    await act(async () => {
      installBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(callLog.some((entry) => entry.startsWith('/api/services/audio-capture/install-preview'))).toBe(true);
    expect(callLog.some((entry) => entry.startsWith('/api/services/audio-capture/install:'))).toBe(false);
    expect(container.textContent).toContain('安装 音频采集');
    expect(container.textContent).toContain('no extra model download');

    const confirmBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === '开始安装');
    expect(confirmBtn).toBeTruthy();

    await act(async () => {
      confirmBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(callLog.some((entry) => entry === '/api/services/audio-capture/install:{"port":19981}')).toBe(true);
  });

  it('does not render lifecycle controls for scriptless (installable=false) services', async () => {
    const scriptlessPayload = {
      services: [
        {
          id: 'audio-capture',
          name: 'Audio Capture',
          description: 'System audio capture',
          category: 'audio',
          features: ['voice-input'],
          endpoint: null,
          configured: true,
          status: 'healthy',
          httpStatus: 200,
          error: null,
          installed: true,
          enabled: true,
          installable: false,
        },
      ],
    };
    mockFetch.mockResolvedValue({ ok: true, json: async () => scriptlessPayload });

    await render(React.createElement(ServiceStatusPanel, { filterFeatures: ['voice-input'], title: '音频' }));

    expect(container.textContent).toContain('音频采集');
    const toggle = container.querySelector('.settings-resource-toggle');
    expect(toggle).toBeFalsy();
    const trashBtn = Array.from(container.querySelectorAll('button')).find((b) => b.title === '卸载');
    expect(trashBtn).toBeFalsy();
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
          installed: false,
          enabled: false,
          installable: true,
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

    const installBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === '安装');
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

  it('restores installing state and log polling after remount', async () => {
    const installingPayload = {
      services: [
        {
          id: 'mlx-tts',
          name: 'MLX TTS',
          description: 'Text to speech',
          category: 'voice',
          features: ['voice-output'],
          endpoint: null,
          configured: false,
          status: 'installing',
          error: null,
          installed: false,
          enabled: false,
          installable: true,
        },
      ],
    };
    mockFetch.mockImplementation(async (path: string) => {
      if (path === '/api/services') {
        return { ok: true, json: async () => installingPayload };
      }
      if (path === '/api/services/mlx-tts/logs') {
        return {
          ok: true,
          json: async () => ({ serviceId: 'mlx-tts', lines: ['Downloading model...', 'Installing deps...'] }),
        };
      }
      return { ok: true, json: async () => ({}) };
    });

    await render(React.createElement(ServiceStatusPanel, { filterFeatures: ['voice-output'], title: 'TTS' }));
    await act(async () => {
      await Promise.resolve();
    });

    expect(container.textContent).toContain('安装中');
    expect(container.textContent).toContain('Installing deps...');
    const installBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === '安装中');
    expect(installBtn).toBeTruthy();
    expect(installBtn?.disabled).toBe(true);
  });

  it('restores uninstalling state and log polling after remount', async () => {
    const uninstallingPayload = {
      services: [
        {
          id: 'mlx-tts',
          name: 'MLX TTS',
          description: 'Text to speech',
          category: 'voice',
          features: ['voice-output'],
          endpoint: 'http://localhost:9879',
          configured: true,
          status: 'uninstalling',
          error: null,
          installed: true,
          enabled: false,
          installable: true,
        },
      ],
    };
    mockFetch.mockImplementation(async (path: string) => {
      if (path === '/api/services') {
        return { ok: true, json: async () => uninstallingPayload };
      }
      if (path === '/api/services/mlx-tts/logs') {
        return {
          ok: true,
          json: async () => ({
            serviceId: 'mlx-tts',
            lines: ['[uninstall] stopped owned process(es) before uninstall: 5151'],
          }),
        };
      }
      return { ok: true, json: async () => ({}) };
    });

    await render(React.createElement(ServiceStatusPanel, { filterFeatures: ['voice-output'], title: 'TTS' }));
    await act(async () => {
      await Promise.resolve();
    });

    expect(container.textContent).toContain('卸载中');
    expect(container.textContent).toContain('[uninstall] stopped owned process(es) before uninstall: 5151');
    const trashBtn = Array.from(container.querySelectorAll('button')).find((b) => b.title === '卸载');
    expect(trashBtn).toBeTruthy();
    expect(trashBtn?.disabled).toBe(true);
  });

  it('refreshes service state while startup is still in progress', async () => {
    const startingPayload = {
      services: [
        {
          id: 'embedding-model',
          name: 'Embedding Model',
          description: 'Semantic memory embedding endpoint',
          category: 'memory',
          features: ['memory-semantic-search'],
          endpoint: 'http://127.0.0.1:9880',
          configured: true,
          status: 'starting',
          httpStatus: null,
          error: null,
          installed: true,
          enabled: true,
          installable: true,
        },
      ],
    };
    const failedPayload = {
      services: [
        {
          id: 'embedding-model',
          name: 'Embedding Model',
          description: 'Semantic memory embedding endpoint',
          category: 'memory',
          features: ['memory-semantic-search'],
          endpoint: 'http://127.0.0.1:9880',
          configured: true,
          status: 'unhealthy',
          httpStatus: null,
          error: 'connect ECONNREFUSED 127.0.0.1:9880',
          installed: true,
          enabled: true,
          installable: true,
        },
      ],
    };

    let serviceFetchCount = 0;
    const onStateChange = vi.fn();
    mockFetch.mockImplementation(async (path: string) => {
      if (path === '/api/services') {
        serviceFetchCount += 1;
        return { ok: true, json: async () => (serviceFetchCount === 1 ? startingPayload : failedPayload) };
      }
      if (path === '/api/services/embedding-model/logs') {
        return {
          ok: true,
          json: async () => ({ serviceId: 'embedding-model', lines: ['Starting embedding server...'] }),
        };
      }
      return { ok: true, json: async () => ({}) };
    });

    await render(
      React.createElement(ServiceStatusPanel, {
        filterFeatures: ['memory-semantic-search'],
        title: '记忆服务',
        onStateChange,
      }),
    );
    expect(container.textContent).toContain('启动中');
    expect(onStateChange).toHaveBeenCalledTimes(1);

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 2100));
    });

    expect(serviceFetchCount).toBeGreaterThanOrEqual(2);
    expect(onStateChange.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(container.textContent).toContain('异常');
    expect(container.textContent).toContain('connect ECONNREFUSED 127.0.0.1:9880');
  });
});
