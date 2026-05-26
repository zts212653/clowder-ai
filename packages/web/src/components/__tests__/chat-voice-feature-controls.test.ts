import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatVoiceFeatureControls } from '@/components/ChatVoiceFeatureControls';
import { useChatStore } from '@/stores/chatStore';
import { useToastStore } from '@/stores/toastStore';
import { useVoiceSessionStore } from '@/stores/voiceSessionStore';
import { apiFetch } from '@/utils/api-client';

vi.mock('@/utils/api-client', () => ({
  apiFetch: vi.fn(),
}));

const apiFetchMock = vi.mocked(apiFetch);

function jsonResponse(body: unknown, ok = true) {
  return {
    ok,
    status: ok ? 200 : 500,
    json: async () => body,
  } as Response;
}

beforeAll(() => {
  (globalThis as { React?: typeof React }).React = React;
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  Object.defineProperty(window.HTMLMediaElement.prototype, 'play', {
    configurable: true,
    value: vi.fn().mockResolvedValue(undefined),
  });
  Object.defineProperty(window.HTMLMediaElement.prototype, 'pause', {
    configurable: true,
    value: vi.fn(),
  });
});

afterAll(() => {
  delete (globalThis as { React?: typeof React }).React;
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  apiFetchMock.mockReset();
  useVoiceSessionStore.setState({ session: null });
  useToastStore.setState({ toasts: [] });
  useChatStore.setState({ rightPanelMode: 'status' });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function render(props: Partial<React.ComponentProps<typeof ChatVoiceFeatureControls>> = {}) {
  act(() => {
    root.render(
      React.createElement(ChatVoiceFeatureControls, {
        threadId: 'thread-1',
        defaultCatId: 'opus',
        ...props,
      }),
    );
  });
}

function button(label: string): HTMLButtonElement {
  const found = container.querySelector(`button[aria-label="${label}"]`);
  if (!found) throw new Error(`button ${label} not found`);
  return found as HTMLButtonElement;
}

describe('ChatVoiceFeatureControls', () => {
  it('renders both header voice entries as inactive gray icon buttons', () => {
    render();

    expect(button('语音陪伴').className).toContain('text-cafe-secondary');
    expect(button('音频采集').className).toContain('text-cafe-secondary');
  });

  it('starts installed-but-disabled TTS service before enabling voice companion', async () => {
    let started = false;
    apiFetchMock.mockImplementation(async (path: string) => {
      if (path === '/api/services') {
        return jsonResponse({
          services: [
            {
              id: 'mlx-tts',
              installed: true,
              enabled: started,
              installable: true,
              status: started ? 'healthy' : 'not_configured',
              features: ['voice-output', 'voice-companion'],
            },
          ],
        });
      }
      if (path === '/api/services/mlx-tts/start') {
        started = true;
        return jsonResponse({ ok: true });
      }
      return jsonResponse({ error: `unexpected ${path}` }, false);
    });
    render();

    await act(async () => {
      button('语音陪伴').click();
    });

    expect(apiFetchMock).toHaveBeenCalledWith('/api/services/mlx-tts/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(useVoiceSessionStore.getState().session?.boundThreadId).toBe('thread-1');
    expect(useVoiceSessionStore.getState().session?.activeCatId).toBe('opus');
  });

  it('waits for an enabled TTS service to become healthy before enabling voice companion', async () => {
    let servicePolls = 0;
    let resolveHealthy: (() => void) | undefined;
    apiFetchMock.mockImplementation(async (path: string) => {
      if (path === '/api/services') {
        servicePolls += 1;
        if (servicePolls === 1) {
          return jsonResponse({
            services: [
              {
                id: 'mlx-tts',
                installed: true,
                enabled: true,
                installable: true,
                status: 'starting',
                features: ['voice-output', 'voice-companion'],
              },
            ],
          });
        }
        return new Promise<Response>((resolve) => {
          resolveHealthy = () =>
            resolve(
              jsonResponse({
                services: [
                  {
                    id: 'mlx-tts',
                    installed: true,
                    enabled: true,
                    installable: true,
                    status: 'healthy',
                    features: ['voice-output', 'voice-companion'],
                  },
                ],
              }),
            );
        });
      }
      return jsonResponse({ error: `unexpected ${path}` }, false);
    });
    render();

    act(() => {
      button('语音陪伴').click();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(servicePolls).toBe(2);
    expect(useVoiceSessionStore.getState().session).toBeNull();

    await act(async () => {
      resolveHealthy?.();
      await Promise.resolve();
    });

    expect(useVoiceSessionStore.getState().session?.boundThreadId).toBe('thread-1');
    expect(useVoiceSessionStore.getState().session?.activeCatId).toBe('opus');
  });

  it('opens transcript mode directly for config-presence audio-capture without calling toggle', async () => {
    apiFetchMock.mockImplementation(async (path: string) => {
      if (path === '/api/services') {
        return jsonResponse({
          services: [
            {
              id: 'audio-capture',
              installed: true,
              enabled: false,
              installable: false,
              features: ['meeting-copilot', 'live-transcript'],
            },
          ],
        });
      }
      return jsonResponse({ error: `unexpected ${path}` }, false);
    });
    render();

    await act(async () => {
      button('音频采集').click();
    });

    expect(apiFetchMock).not.toHaveBeenCalledWith(expect.stringContaining('/toggle'), expect.anything());
    expect(useChatStore.getState().rightPanelMode).toBe('transcript');
  });

  it('does not activate a missing voice service and directs the user to voice management', async () => {
    apiFetchMock.mockResolvedValue(
      jsonResponse({
        services: [
          {
            id: 'audio-capture',
            installed: false,
            enabled: false,
            installable: false,
            features: ['meeting-copilot', 'live-transcript'],
          },
        ],
      }),
    );
    render();

    await act(async () => {
      button('音频采集').click();
    });

    expect(useChatStore.getState().rightPanelMode).toBe('status');
    expect(useToastStore.getState().toasts[0]?.message).toContain('语音管理');
  });

  it('opens install preview from the audio capture header action before installing', async () => {
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
    const callLog: string[] = [];
    let audioInstalled = false;
    let audioEnabled = false;
    apiFetchMock.mockImplementation(async (path: string, init?: RequestInit) => {
      callLog.push(`${path}:${init?.body ?? ''}`);
      if (path === '/api/services') {
        return jsonResponse({
          services: [
            {
              id: 'audio-capture',
              installed: audioInstalled,
              enabled: audioEnabled,
              installable: true,
              status: audioEnabled ? 'healthy' : 'not_configured',
              features: ['meeting-copilot', 'live-transcript'],
              prerequisites: {
                runtime: 'python3.10+',
                packages: ['sounddevice', 'fastapi', 'uvicorn', 'numpy'],
                models: [],
                estimatedMinutes: 2,
              },
            },
          ],
        });
      }
      if (path === '/api/services/audio-capture/install-preview') {
        return jsonResponse({
          profile,
          suggestedPort: 19981,
          recommendation: {
            serviceId: 'audio-capture',
            profile,
            models: [],
            notes: ['Windows: sounddevice uses WASAPI / DirectSound, no extra model download.'],
          },
        });
      }
      if (path === '/api/services/audio-capture/install') {
        audioInstalled = true;
        return jsonResponse({ ok: true });
      }
      if (path === '/api/services/audio-capture/start') {
        audioEnabled = true;
        return jsonResponse({ ok: true });
      }
      return jsonResponse({ error: `unexpected ${path}` }, false);
    });
    render();

    await act(async () => {
      button('音频采集').click();
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(callLog.some((entry) => entry.startsWith('/api/services/audio-capture/install-preview'))).toBe(true);
    expect(callLog.some((entry) => entry.startsWith('/api/services/audio-capture/install:'))).toBe(false);
    expect(container.textContent).toContain('安装 音频采集');
    expect(container.textContent).toContain('无需模型');
    expect(container.textContent).toContain('语音识别模型请在 Whisper 服务中选择');
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
    expect(callLog.some((entry) => entry === '/api/services/audio-capture/start:{}')).toBe(true);
    expect(useChatStore.getState().rightPanelMode).toBe('transcript');
  });
});
