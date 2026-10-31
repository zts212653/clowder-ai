import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatVoiceFeatureControls } from '@/components/ChatVoiceFeatureControls';
import { writeShellLanguage } from '@/components/shell/shell-language';
import { writeShellPresentation } from '@/components/shell/shell-presentation';
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

const healthyVoiceService = {
  id: 'mlx-tts',
  installed: true,
  enabled: true,
  installable: true,
  status: 'healthy',
};
const healthyAudioService = {
  id: 'audio-capture',
  installed: true,
  enabled: true,
  installable: true,
  status: 'healthy',
};

function mockServices(...services: unknown[]) {
  apiFetchMock.mockImplementation(async (input) => {
    const url = String(input);
    if (url === '/api/services') return jsonResponse({ services });
    if (url === '/api/audio/status') return jsonResponse({ running: false });
    if (url.startsWith('/api/services/') && url.endsWith('/logs'))
      return jsonResponse({ lines: ['boot failed: no mic'] });
    return jsonResponse({});
  });
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
  writeShellPresentation('v2');
  writeShellLanguage('zh');
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  writeShellPresentation('classic');
});

async function render(props: Partial<React.ComponentProps<typeof ChatVoiceFeatureControls>> = {}) {
  await act(async () => {
    root.render(
      React.createElement(ChatVoiceFeatureControls, {
        threadId: 'thread-1',
        defaultCatId: 'opus',
        ...props,
      }),
    );
  });
  // let the service/status fetches settle
  await act(async () => {});
  await act(async () => {});
}

describe('ChatVoiceFeatureControls v2', () => {
  it('renders the two companion cards with v2 words and 未在采集', async () => {
    mockServices(healthyVoiceService, healthyAudioService);
    await render();
    expect(container.querySelector('[data-testid="workspace-companion-voice"]')?.textContent).toContain('语音陪伴');
    expect(container.querySelector('[data-testid="workspace-companion-voice"]')?.textContent).toContain(
      '让当前猫猫朗读之后的回复',
    );
    const meeting = container.querySelector('[data-testid="workspace-companion-meeting"]');
    expect(meeting?.textContent).toContain('会议伴随');
    expect(meeting?.textContent).toContain('未在采集');
  });

  it('labels the install estimate as an estimate, never a countdown', async () => {
    mockServices(
      { id: 'mlx-tts', installed: false, enabled: false, installable: true, prerequisites: { estimatedMinutes: 3 } },
      {
        id: 'audio-capture',
        installed: false,
        enabled: false,
        installable: true,
        prerequisites: { estimatedMinutes: 10 },
      },
    );
    await render();
    const voice = container.querySelector('[data-testid="workspace-companion-voice"]');
    expect(voice?.textContent).toContain('预计约 3 分钟（安装包估算）');
    const meeting = container.querySelector('[data-testid="workspace-companion-meeting"]');
    expect(meeting?.textContent).toContain('预计约 10 分钟（安装包估算）');
    expect(container.querySelector('[data-testid="voice-companion-install"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="meeting-companion-install"]')).not.toBeNull();
  });

  it('shows startup failure with the service error and a real log viewer', async () => {
    mockServices(
      {
        id: 'mlx-tts',
        installed: true,
        enabled: true,
        installable: true,
        status: 'unhealthy',
        error: '没有麦克风权限',
      },
      healthyAudioService,
    );
    await render();
    const voice = container.querySelector('[data-testid="workspace-companion-voice"]');
    expect(voice?.textContent).toContain('语音合成启动失败：没有麦克风权限');
    const logsButton = Array.from(voice?.querySelectorAll('button') ?? []).find((b) =>
      b.textContent?.includes('查看日志'),
    ) as HTMLButtonElement;
    expect(logsButton).toBeTruthy();
    await act(async () => {
      logsButton.click();
    });
    expect(container.querySelector('[data-testid="service-logs-voice-companion"]')?.textContent).toContain(
      'boot failed: no mic',
    );
  });

  it('shows the active voice session with cat name and playback controls, without a queue ordinal', async () => {
    mockServices(healthyVoiceService, healthyAudioService);
    useVoiceSessionStore.getState().start('thread-1', 'fable-5', true);
    useVoiceSessionStore.getState().setPlaybackState('playing');
    await render();
    const voice = container.querySelector('[data-testid="workspace-companion-voice"]');
    expect(voice?.textContent).toContain('朗读中');
    expect(voice?.textContent).not.toContain('第');
    expect(container.querySelector('[data-testid="voice-companion-pause-resume"]')?.textContent).toContain('暂停');
    expect(container.querySelector('[data-testid="voice-companion-skip"]')?.textContent).toContain('跳过');
    expect(container.querySelector('[data-testid="voice-companion-stop"]')?.textContent).toContain('结束');
  });

  it('renders English when the shell language is en', async () => {
    mockServices(healthyVoiceService, healthyAudioService);
    writeShellLanguage('en');
    await render();
    const meeting = container.querySelector('[data-testid="workspace-companion-meeting"]');
    expect(meeting?.textContent).toContain('Meeting companion');
    expect(meeting?.textContent).toContain('Not capturing');
  });
});

describe('Sol independent service/capture probes', () => {
  it('a service finishing startup becomes actionable without reloading', async () => {
    vi.useFakeTimers();
    let ready = false;
    apiFetchMock.mockImplementation(async (input) =>
      String(input) === '/api/services'
        ? jsonResponse({
            services: [{ ...healthyVoiceService, status: ready ? 'healthy' : 'starting' }, healthyAudioService],
          })
        : jsonResponse({ running: false }),
    );
    try {
      await render();
      expect(container.textContent).toContain('正在启动语音合成');
      ready = true;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(20_000);
      });
      expect(container.querySelector('[data-testid="voice-companion-start"]')).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
  it('the home card distinguishes a paused capture from live capture', async () => {
    apiFetchMock.mockImplementation(async (input) =>
      String(input) === '/api/services'
        ? jsonResponse({ services: [healthyVoiceService, healthyAudioService] })
        : jsonResponse({ running: true, paused: true, inputs: [{ id: 'app', label: 'QuickTime' }] }),
    );
    await render();
    expect(container.querySelector('[data-testid="workspace-companion-meeting"]')?.textContent).toContain('已暂停');
  });
  it('the action labelled Pop out actually opens the floating window', async () => {
    apiFetchMock.mockImplementation(async (input) =>
      String(input) === '/api/services'
        ? jsonResponse({ services: [healthyVoiceService, healthyAudioService] })
        : jsonResponse({ running: true }),
    );
    useChatStore.setState({ floatingTranscriptVisible: false });
    await render();
    await act(async () => {
      (container.querySelector('[data-testid="meeting-companion-open"]') as HTMLButtonElement).click();
    });
    expect(useChatStore.getState().floatingTranscriptVisible).toBe(true);
  });
});
