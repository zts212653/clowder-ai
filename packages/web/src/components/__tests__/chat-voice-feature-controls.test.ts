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
    apiFetchMock.mockImplementation(async (path: string) => {
      if (path === '/api/services') {
        return jsonResponse({
          services: [
            {
              id: 'mlx-tts',
              installed: true,
              enabled: false,
              installable: true,
              features: ['voice-output', 'voice-companion'],
            },
          ],
        });
      }
      if (path === '/api/services/mlx-tts/start') return jsonResponse({ ok: true });
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
});
