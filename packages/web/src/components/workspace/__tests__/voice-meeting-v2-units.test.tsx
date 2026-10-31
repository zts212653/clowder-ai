import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeShellLanguage } from '@/components/shell/shell-language';
import { writeShellPresentation } from '@/components/shell/shell-presentation';
import { useChatStore } from '@/stores/chatStore';
import { apiFetch } from '@/utils/api-client';
import { AudioHealthStrip } from '../AudioHealthStrip';
import type { AudioStatus } from '../audio-transcript-contract';
import { FloatingTranscriptWindow } from '../FloatingTranscriptWindow';
import { SavedPathsV2 } from '../SavedPathsV2';
import { TranscriptCaptureHeader } from '../TranscriptCaptureHeader';

vi.mock('@/utils/api-client', () => ({
  apiFetch: vi.fn(),
}));

const apiFetchMock = vi.mocked(apiFetch);

function jsonResponse(body: unknown, ok = true) {
  return { ok, status: ok ? 200 : 500, json: async () => body } as Response;
}

beforeAll(() => {
  (globalThis as { React?: typeof React }).React = React;
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterAll(() => {
  delete (globalThis as { React?: typeof React }).React;
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  apiFetchMock.mockReset();
  apiFetchMock.mockImplementation(async () => jsonResponse({ worktrees: [] }));
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

async function renderInto(element: React.ReactElement) {
  await act(async () => {
    root.render(element);
  });
  await act(async () => {});
}

const stoppedStatus: AudioStatus = {
  running: false,
  inputs: [
    { id: 'app', source: 'app', label: '会议软件', state: 'running' },
    { id: 'mic', source: 'mic', label: '本机麦克风', state: 'failed', reason: 'device unplugged' },
  ],
  health: {
    asr: { state: 'ready', model: 'whisper-large' },
    speaker_separation: { state: 'degraded', reason: 'cluster model reloading' },
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
};

describe('TranscriptCaptureHeader v2', () => {
  it('running: real source label, 暂停/停止 and the picture-in-picture pop-out', async () => {
    await renderInto(
      <TranscriptCaptureHeader
        status={{ running: true }}
        sourceLabel="会议软件 + 本机麦克风"
        elapsed={80}
        onResume={() => {}}
        onPause={() => {}}
        onStop={() => {}}
        onPopOut={() => {}}
      />,
    );
    expect(container.textContent).toContain('会议软件 + 本机麦克风');
    expect(container.textContent).toContain('暂停');
    expect(container.textContent).toContain('停止');
    expect(container.textContent).toContain('01:20');
    expect(container.querySelector('[data-testid="pop-out"]')?.getAttribute('aria-label')).toBe('弹出成浮窗');
  });

  it('stopped with a session: 已停止 · 共 N 分钟 and 重新开始', async () => {
    await renderInto(
      <TranscriptCaptureHeader
        status={{ running: false }}
        sourceLabel="—"
        elapsed={38 * 60}
        hasSession
        onResume={() => {}}
        onPause={() => {}}
        onStop={() => {}}
        onStartAgain={() => {}}
        onPopOut={() => {}}
      />,
    );
    expect(container.textContent).toContain('已停止 · 共 38 分钟');
    expect(container.querySelector('[data-testid="start-again"]')?.textContent).toContain('重新开始');
  });
});

describe('AudioHealthStrip v2', () => {
  it('renders real health as tags, marks them 上次 after a stop, keeps diagnostics raw', async () => {
    await renderInto(<AudioHealthStrip status={stoppedStatus} />);
    const text = container.textContent ?? '';
    expect(text).toContain('上次 · 语音识别 正常');
    expect(text).toContain('上次 · 说话人区分 降级');
    expect(text).toContain('会议软件 已停止');
    expect(text).toContain('本机麦克风 失败');
    expect(text).toContain('cluster model reloading');
    expect(text).toContain('device unplugged');
  });

  it('live session: 学习中 while clusters are provisional', async () => {
    await renderInto(<AudioHealthStrip status={{ ...stoppedStatus, running: true }} />);
    const text = container.textContent ?? '';
    expect(text).toContain('语音识别 正常');
    expect(text).toContain('说话人区分 降级');
    expect(text).toContain('会议软件 运行中');
    expect(text).not.toContain('上次');
  });
});

describe('SavedPathsV2', () => {
  it('opens in Files when the path is inside a listed worktree, with the relative path', async () => {
    apiFetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url.startsWith('/api/workspace/worktrees')) {
        return jsonResponse({
          worktrees: [{ id: 'wt-1', root: '/repo/main', resolvedRoot: '/repo/main', branch: 'main', head: 'abc' }],
        });
      }
      return jsonResponse({});
    });
    useChatStore.setState({ workspaceWorktreeId: 'wt-1' });
    await renderInto(
      <SavedPathsV2
        savedPath="/repo/main/scripts/meeting-copilot/transcripts/2026-10-02.md"
        savedRecordingPaths={{ app: '/repo/main/scripts/meeting-copilot/transcripts/recording-app.wav' }}
        inputLabels={{ app: '会议软件' }}
      />,
    );
    const openButton = container.querySelector('[data-testid="saved-path-open"]') as HTMLButtonElement;
    expect(openButton?.textContent).toContain('在文件里打开');
    expect(container.textContent).toContain('录音已保存 · 会议软件');
    await act(async () => {
      openButton.click();
    });
    expect(useChatStore.getState().workspaceOpenFilePath).toBe('scripts/meeting-copilot/transcripts/2026-10-02.md');
  });
});

describe('FloatingTranscriptWindow v2', () => {
  const sampleLines = [
    {
      ts: 1715400000,
      elapsed_s: 10,
      chunk_num: 1,
      asr_latency: 0.3,
      text: '周五我可能来不了',
      speaker_label: '说话人 3',
      input_label: '会议软件',
    },
  ];

  it('header carries 主动提醒 switch, minimize and close; advisory card has DND and dismiss', async () => {
    await renderInto(
      <FloatingTranscriptWindow
        lines={sampleLines}
        connected
        recording
        sourceLabel="会议软件"
        elapsed={102}
        advisoryMode="active"
        onToggleAdvisory={() => {}}
        onClose={() => {}}
        advisory={{
          type: 'intervention_advisory',
          ts: 1715400001,
          reason: 'question_detected',
          confidence: 0.9,
          source_chunk_num: 1,
          source_text: '吴浪问“周五几点评审”。',
          talking_point: '周五 15:00，You 和小太阳都在。',
        }}
        onAdvisoryDismiss={() => {}}
        onAdvisoryDnd={() => {}}
      />,
    );
    const text = container.textContent ?? '';
    expect(text).toContain('主动提醒');
    expect(text).toContain('01:42');
    expect(text).toContain('检测到提问');
    expect(text).toContain('吴浪问“周五几点评审”。');
    expect(text).toContain('15 分钟内不打扰');
    expect(text).toContain('忽略');
    expect(text).toContain('周五我可能来不了');
    expect(text).toContain('说话人 3');
    expect(container.querySelector('[data-testid="advisory-switch"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="floating-minimize"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="floating-close"]')).not.toBeNull();
    expect(text).toContain('1 段');
    expect(text).toContain('实时连接正常');
  });

  it('renders English chrome when the shell language is en, while data stays as-is', async () => {
    writeShellLanguage('en');
    await renderInto(<FloatingTranscriptWindow lines={sampleLines} connected recording={false} onClose={() => {}} />);
    const text = container.textContent ?? '';
    expect(text).toContain('Meeting companion');
    expect(text).toContain('1 segment');
    expect(text).toContain('Live connection OK');
    expect(text).toContain('周五我可能来不了');
    expect(text).toContain('说话人 3');
  });
});

describe('Sol independent language/return probes', () => {
  it('an English advisory with a talking point has no hardcoded Chinese chrome', async () => {
    writeShellLanguage('en');
    await renderInto(
      <FloatingTranscriptWindow
        lines={[]}
        connected
        recording
        onClose={() => {}}
        advisory={{
          type: 'intervention_advisory',
          ts: 1,
          reason: 'question_detected',
          confidence: 0.8,
          source_chunk_num: 1,
          source_text: 'A real question',
          talking_point: 'Keep this raw point',
        }}
      />,
    );
    expect(container.textContent).toContain('Keep this raw point');
    expect(container.textContent).not.toContain('要点：');
  });
  it('opening a saved meeting file carries a return origin', async () => {
    apiFetchMock.mockImplementation(async (input) =>
      String(input).startsWith('/api/workspace/worktrees')
        ? jsonResponse({
            worktrees: [{ id: 'wt-1', root: '/repo/main', resolvedRoot: '/repo/main', branch: 'main', head: 'abc' }],
          })
        : jsonResponse({}),
    );
    useChatStore.setState({
      currentThreadId: 'meeting-thread',
      workspaceWorktreeId: 'wt-1',
      _workspaceFileSetAt: { ts: 0, threadId: null },
    });
    await renderInto(<SavedPathsV2 savedPath="/repo/main/transcripts/meeting.md" ownerThreadId="meeting-thread" />);
    await act(async () => {
      (container.querySelector('[data-testid="saved-path-open"]') as HTMLButtonElement).click();
    });
    expect(useChatStore.getState()._workspaceFileSetAt.navigationOrigin).toBeDefined();
  });
});
