import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeShellLanguage } from '@/components/shell/shell-language';
import { writeShellPresentation } from '@/components/shell/shell-presentation';
import { clearMeetingSessionSummary, readMeetingSessionSummary } from '../meeting-session-summary';
import { TranscriptPanel } from '../TranscriptPanel';

let reviewThreadId = 'test-thread';

const mockApiFetch = vi.fn();

vi.mock('@/utils/api-client', () => ({
  apiFetch: (...args: unknown[]) => mockApiFetch(...args),
  API_URL: 'http://test',
}));

vi.mock('@/stores/chatStore', () => ({
  useChatStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({
      setRightPanelMode: () => {},
      setFloatingTranscriptVisible: () => {},
      currentThreadId: reviewThreadId,
    }),
}));

type FakeESInstance = {
  onopen: ((ev?: unknown) => void) | null;
  onerror: ((ev?: unknown) => void) | null;
  onmessage: ((ev: { data: string }) => void) | null;
  close: () => void;
};
let latestEventSource: FakeESInstance | null = null;

vi.stubGlobal('EventSource', function FakeEventSource(this: unknown) {
  const instance: FakeESInstance = {
    onopen: null,
    onerror: null,
    onmessage: null,
    close() {},
  };
  latestEventSource = instance;
  queueMicrotask(() => instance.onopen?.());
  return instance;
});

function jsonResponse(body: unknown, ok = true) {
  return { ok, status: ok ? 200 : 500, json: async () => body } as Response;
}

const sampleSources = {
  apps: [{ id: 'welink', name: '会议软件' }],
  mics: [{ index: 0, name: '本机麦克风', default: true }],
};

describe('TranscriptPanel v2', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    (globalThis as Record<string, unknown>).React = React;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterAll(() => {
    delete (globalThis as Record<string, unknown>).React;
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  beforeEach(() => {
    mockApiFetch.mockReset();
    clearMeetingSessionSummary();
    reviewThreadId = 'test-thread';
    latestEventSource = null;
    writeShellPresentation('v2');
    writeShellLanguage('zh');
    mockApiFetch.mockImplementation(async (input) => {
      const url = String(input);
      if (url === '/api/audio/status') return jsonResponse({ running: false });
      if (url.startsWith('/api/audio/transcript')) return jsonResponse({ lines: [] });
      if (url === '/api/audio/sources') return jsonResponse(sampleSources);
      return jsonResponse({});
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    writeShellPresentation('classic');
  });

  async function renderPanel() {
    await act(async () => {
      root.render(React.createElement(TranscriptPanel));
    });
    await act(async () => {});
    await act(async () => {});
  }

  it('prepare state: real source pickers, 开始采集, one-of-two hint and the honest empty text', async () => {
    await renderPanel();
    expect(container.textContent).toContain('会议伴随');
    expect(container.textContent).toContain('未在采集');
    expect(container.textContent).toContain('应用声音');
    expect(container.textContent).toContain('麦克风');
    expect(container.textContent).toContain('会议软件');
    expect(container.textContent).toContain('本机麦克风（默认）');
    expect(container.querySelector('[data-testid="start-capture"]')?.textContent).toContain('开始采集');
    expect(container.textContent).toContain('两路可以只选一路');
    expect(container.textContent).toContain('还没有转写。开始采集后，会逐句出现在这里。');
  });

  it('footer speaks the dictionary and drops the unmeasured 16kHz literal', async () => {
    await renderPanel();
    const text = container.textContent ?? '';
    expect(text).toContain('0 段');
    expect(text).toContain('平均延迟 —');
    expect(text).toContain('实时连接正常');
    expect(text).not.toContain('16kHz');
    expect(text).not.toContain('chunks');
  });

  it('pop-out affordance is the picture-in-picture icon, not ⤢', async () => {
    await renderPanel();
    const popOut = container.querySelector('[data-testid="pop-out"]');
    expect(popOut?.getAttribute('aria-label')).toBe('弹出成浮窗');
    expect(popOut?.textContent).not.toContain('↗');
    expect(popOut?.querySelector('svg')).not.toBeNull();
  });

  it('stopped state: 已停止 · 共 N 分钟, saved paths and 重新开始', async () => {
    await renderPanel();
    await act(async () => {
      latestEventSource?.onmessage?.({
        data: JSON.stringify({
          type: 'status',
          status: 'started',
          inputs: [{ id: 'app', label: '会议软件', state: 'running' }],
        }),
      });
    });
    await act(async () => {
      latestEventSource?.onmessage?.({
        data: JSON.stringify({
          type: 'transcript',
          ts: 1715400000,
          elapsed_s: 5,
          chunk_num: 1,
          asr_latency: 0.3,
          text: '第一句转写',
          speaker_label: 'You',
          input_label: '会议软件',
        }),
      });
    });
    // let a second tick so the stopped duration is real
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1100));
    });
    await act(async () => {
      latestEventSource?.onmessage?.({
        data: JSON.stringify({
          type: 'status',
          status: 'stopped',
          transcript_path: '/tmp/outside-workspace/transcripts/2026-10-02.md',
          recording_paths: { app: '/tmp/outside-workspace/recordings/app.wav' },
        }),
      });
    });
    await act(async () => {});

    const text = container.textContent ?? '';
    expect(text).toContain('已停止');
    expect(text).toContain('转写已保存');
    expect(text).toContain('/tmp/outside-workspace/transcripts/2026-10-02.md');
    expect(text).toContain('录音已保存 · 会议软件');
    expect(text).toContain('第一句转写');
    // the path is outside every listed worktree: copy-path plus the honest 工作区外 tag, no 在文件里打开
    const outsideTag = container.querySelector('[data-testid="saved-path-outside"]');
    expect(outsideTag?.textContent).toContain('工作区外');
    expect(outsideTag?.getAttribute('title')).toContain('文件在当前工作区之外，可复制路径后自行打开');
    expect(container.querySelector('[data-testid="saved-path-open"]')).toBeNull();
    expect(container.querySelector('[data-testid="start-again"]')?.textContent).toContain('重新开始');
    // health after stop is marked as last-known, not live
    expect(text).toContain('上次');

    await act(async () => {
      (container.querySelector('[data-testid="start-again"]') as HTMLButtonElement).click();
    });
    expect(container.textContent).toContain('两路可以只选一路');
    expect(container.textContent).toContain('还没有转写。开始采集后，会逐句出现在这里。');
  });

  it('live state: pause/stop controls, health tags and per-line time/speaker/source', async () => {
    mockApiFetch.mockImplementation(async (input) => {
      const url = String(input);
      if (url === '/api/audio/status')
        return jsonResponse({
          running: true,
          duration_s: 80,
          inputs: [
            { id: 'app', label: '会议软件', state: 'running' },
            { id: 'mic', label: '本机麦克风', state: 'running' },
          ],
          health: {
            asr: { state: 'ready' },
            speaker_separation: { state: 'ready' },
          },
          cluster_diagnostics: {
            confirmed: 2,
            provisional: 1,
            max_clusters: 8,
            confirmations_required: 3,
            birth_threshold: 0.6,
            assignment_threshold: 0.5,
            replacements: 0,
          },
        });
      if (url.startsWith('/api/audio/transcript'))
        return jsonResponse({
          lines: [
            {
              ts: 1715400000,
              elapsed_s: 5,
              chunk_num: 1,
              asr_latency: 0.3,
              text: '先看一下两个版本',
              speaker_label: 'You',
              input_label: '会议软件',
            },
          ],
        });
      if (url === '/api/audio/sources') return jsonResponse(sampleSources);
      return jsonResponse({});
    });
    await renderPanel();
    const text = container.textContent ?? '';
    expect(text).toContain('会议软件 + 本机麦克风');
    expect(text).toContain('暂停');
    expect(text).toContain('停止');
    expect(text).toContain('语音识别 正常');
    expect(text).toContain('说话人区分 学习中');
    expect(text).toContain('会议软件 运行中');
    expect(text).toContain('You');
    expect(text).toContain('先看一下两个版本');
    expect(text).toContain('1 段');
  });
  it('Sol probe: a local source failure speaks current zh and switches to en without remount', async () => {
    mockApiFetch.mockRejectedValue(new Error('network down'));
    await renderPanel();
    expect(container.textContent).toContain('音频服务离线。');
    await act(async () => {
      writeShellLanguage('en');
    });
    expect(container.textContent).toContain('Audio service is offline.');
  });

  it('Sol probe: a saved result survives leaving the docked panel and returning in the same session', async () => {
    const persistedLines = [{ ts: 1715400000, elapsed_s: 5, chunk_num: 1, asr_latency: 0.3, text: 'Actual line' }];
    // The real producer reports thread_id on every status; without it the R4 fail-closed rule would (correctly)
    // refuse to retain, so this probe models the actual contract.
    mockApiFetch.mockImplementation(async (input) =>
      String(input) === '/api/audio/status'
        ? jsonResponse({ running: false, thread_id: 'test-thread' })
        : String(input) === '/api/audio/sources'
          ? jsonResponse(sampleSources)
          : String(input) === '/api/audio/transcript'
            ? jsonResponse({ lines: [] })
            : jsonResponse({}),
    );
    await renderPanel();
    await act(async () => {
      latestEventSource?.onmessage?.({
        data: JSON.stringify({
          type: 'status',
          status: 'stopped',
          transcript_path: '/tmp/meeting.md',
          recording_paths: { app: '/tmp/meeting.mp3' },
        }),
      });
    });
    expect(container.textContent).toContain('/tmp/meeting.md');
    await act(async () => {
      root.render(null);
    });
    mockApiFetch.mockImplementation(async (input) =>
      String(input) === '/api/audio/status'
        ? jsonResponse({ running: false, duration_s: 5 })
        : String(input) === '/api/audio/transcript'
          ? jsonResponse({ lines: persistedLines })
          : String(input) === '/api/audio/sources'
            ? jsonResponse(sampleSources)
            : jsonResponse({}),
    );
    await renderPanel();
    expect(container.textContent).toContain('/tmp/meeting.md');
  });

  it('Sol probe: a live SSE line updates latency after a mid-session status snapshot', async () => {
    mockApiFetch.mockImplementation(async (input) =>
      String(input) === '/api/audio/status'
        ? jsonResponse({ running: true, avg_asr_latency: 0.3 })
        : String(input) === '/api/audio/transcript'
          ? jsonResponse({ lines: [{ ts: 1, elapsed_s: 1, chunk_num: 1, asr_latency: 0.3, text: 'one' }] })
          : String(input) === '/api/audio/sources'
            ? jsonResponse(sampleSources)
            : jsonResponse({}),
    );
    await renderPanel();
    await act(async () => {
      latestEventSource?.onmessage?.({
        data: JSON.stringify({
          type: 'transcript',
          ts: 2,
          elapsed_s: 2,
          chunk_num: 2,
          asr_latency: 0.9,
          text: 'two',
        }),
      });
    });
    expect(container.textContent).toContain('平均延迟 0.60 秒');
  });
  async function createStoppedMeetingForProbe() {
    await renderPanel();
    await act(async () => {
      latestEventSource?.onmessage?.({
        data: JSON.stringify({
          type: 'transcript',
          ts: 1,
          elapsed_s: 3,
          chunk_num: 1,
          asr_latency: 0.4,
          text: 'Private content from meeting A',
        }),
      });
    });
    await act(async () => {
      latestEventSource?.onmessage?.({
        data: JSON.stringify({
          type: 'status',
          status: 'stopped',
          transcript_path: '/repo/meeting-A.md',
          recording_paths: { app: '/repo/meeting-A.mp3' },
          duration_s: 3,
        }),
      });
    });
    expect(container.textContent).toContain('/repo/meeting-A.md');
    await act(async () => {
      root.render(null);
    });
  }

  it('R2 probe: stopped results cannot be restored into another thread', async () => {
    reviewThreadId = 'thread-A';
    await createStoppedMeetingForProbe();
    reviewThreadId = 'thread-B';
    await renderPanel();
    expect(container.textContent).not.toContain('/repo/meeting-A.md');
    expect(container.textContent).not.toContain('Private content from meeting A');
    expect(container.querySelector('[data-testid="start-capture"]')).not.toBeNull();
  });

  it('R2 probe: classic retains its previous unload/reload behavior', async () => {
    writeShellPresentation('classic');
    await createStoppedMeetingForProbe();
    await renderPanel();
    expect(container.textContent).not.toContain('/repo/meeting-A.md');
  });

  it('R2 probe: re-entering a new running capture after missed started SSE must not restore old lines', async () => {
    await createStoppedMeetingForProbe();
    mockApiFetch.mockImplementation(async (input) =>
      String(input) === '/api/audio/status'
        ? jsonResponse({ running: true, duration_s: 1, avg_asr_latency: null })
        : String(input) === '/api/audio/transcript'
          ? jsonResponse({ lines: [] })
          : String(input) === '/api/audio/sources'
            ? jsonResponse(sampleSources)
            : jsonResponse({}),
    );
    await renderPanel();
    expect(container.textContent).not.toContain('Private content from meeting A');
    expect(container.textContent).toContain('正在等待第一段转写');
  });

  it('R3 probe: a B capture after a mounted A-to-B thread switch retains B identity', async () => {
    reviewThreadId = 'thread-A';
    await renderPanel();
    const firstEventSource = latestEventSource;
    reviewThreadId = 'thread-B';
    await renderPanel();
    expect(latestEventSource).toBe(firstEventSource);
    mockApiFetch.mockImplementation(async (input) =>
      String(input) === '/api/audio/start'
        ? jsonResponse({ status: { running: true, thread_id: 'thread-B', started_at: 100 } })
        : jsonResponse({}),
    );
    await act(async () => {
      const select = container.querySelector('select') as HTMLSelectElement;
      select.value = 'welink';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await act(async () => {
      (container.querySelector('[data-testid="start-capture"]') as HTMLButtonElement).click();
    });
    const startCall = mockApiFetch.mock.calls.find(([path]) => path === '/api/audio/start');
    expect(JSON.parse(startCall?.[1]?.body as string).thread_id).toBe('thread-B');
    await act(async () => {
      latestEventSource?.onmessage?.({
        data: JSON.stringify({
          type: 'transcript',
          ts: 101,
          elapsed_s: 1,
          chunk_num: 1,
          asr_latency: 0.3,
          text: 'B meeting content',
        }),
      });
    });
    await act(async () => {
      latestEventSource?.onmessage?.({
        data: JSON.stringify({
          type: 'status',
          status: 'stopped',
          transcript_path: '/repo/meeting-B.md',
          duration_s: 1,
        }),
      });
    });
    const owner = readMeetingSessionSummary()?.threadId;
    await act(async () => {
      root.render(null);
    });
    mockApiFetch.mockImplementation(async (input) =>
      String(input) === '/api/audio/status'
        ? jsonResponse({ running: false })
        : String(input) === '/api/audio/sources'
          ? jsonResponse(sampleSources)
          : String(input) === '/api/audio/transcript'
            ? jsonResponse({ lines: [] })
            : jsonResponse({}),
    );
    await renderPanel();
    const bRestoresOwnResult = container.textContent?.includes('/repo/meeting-B.md');
    await act(async () => {
      root.render(null);
    });
    reviewThreadId = 'thread-A';
    await renderPanel();
    const aRestoresBResult = container.textContent?.includes('/repo/meeting-B.md');
    expect({ owner, bRestoresOwnResult, aRestoresBResult }).toEqual({
      owner: 'thread-B',
      bRestoresOwnResult: true,
      aRestoresBResult: false,
    });
  });

  it('R2 probe: Start again must clear numeric status latency snapshot', async () => {
    mockApiFetch.mockImplementation(async (input) =>
      String(input) === '/api/audio/status'
        ? jsonResponse({ running: false, avg_asr_latency: 0.3 })
        : String(input) === '/api/audio/transcript'
          ? jsonResponse({ lines: [{ ts: 1, elapsed_s: 1, chunk_num: 1, asr_latency: 0.3, text: 'one' }] })
          : String(input) === '/api/audio/sources'
            ? jsonResponse(sampleSources)
            : jsonResponse({}),
    );
    await renderPanel();
    await act(async () => {
      (container.querySelector('[data-testid="start-again"]') as HTMLButtonElement).click();
    });
    expect(container.textContent).toContain('平均延迟 —');
    expect(container.textContent).not.toContain('平均延迟 0.30');
  });
});
