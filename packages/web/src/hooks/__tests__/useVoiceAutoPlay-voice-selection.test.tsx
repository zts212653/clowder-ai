import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { useChatStore } from '@/stores/chatStore';
import { useListenModeStore } from '@/stores/listenModeStore';
import { useToastStore } from '@/stores/toastStore';
import { useVoiceSessionStore } from '@/stores/voiceSessionStore';
import { streamTts } from '@/utils/tts-stream';
import { useVoiceAutoPlay } from '../useVoiceAutoPlay';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn(async () => new Response()) }));
vi.mock('@/utils/tts-stream', async (original) => ({
  ...(await original<typeof import('@/utils/tts-stream')>()),
  streamTts: vi.fn(),
}));
vi.mock('@/services/playbackRuntime', () => ({ peekPlaybackManager: () => null }));

it.each([
  false,
  true,
  'error',
])('keeps repeated notices quiet and surfaces a changed reader receipt (changed=%s)', async (changed) => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:voice'), revokeObjectURL: vi.fn() });
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
  const warning = '未配置本人声线，本次使用全局默认声音。';
  const voiceSelection = {
    catId: 'opus',
    source: 'global_default' as const,
    provider: 'fixture',
    model: 'fixture',
    requested: { voice: 'test', langCode: 'zh' },
    effective: { voice: 'test', langCode: 'zh' },
    referenceStatus: 'not_requested' as const,
    warnings: [warning],
  };
  const nextSelection = changed
    ? {
        ...voiceSelection,
        referenceStatus: 'unavailable' as const,
        warnings: ['参考音频无法读取，本次未使用参考音频克隆。'],
      }
    : voiceSelection;
  vi.mocked(streamTts).mockClear();
  vi.mocked(streamTts).mockImplementation(async function* () {
    yield { type: 'chunk', index: 0, audioBase64: btoa('audio'), format: 'wav', voiceSelection };
    if (changed === 'error') throw new Error('参考音频在同一任务中发生变化，已停止后续语音。');
    yield { type: 'chunk', index: 1, audioBase64: btoa('audio'), format: 'wav', voiceSelection: nextSelection };
    yield { type: 'done', total: 2, voiceSelection: nextSelection };
  });
  useToastStore.setState({ toasts: [] });
  useListenModeStore.setState({ session: null });
  useVoiceSessionStore.getState().start('voice-test', 'opus', true);
  useChatStore.setState({
    currentThreadId: 'voice-test',
    messages: [
      {
        id: 'voice-message',
        type: 'assistant',
        catId: 'opus',
        content: '',
        timestamp: 1,
        extra: { rich: { v: 1, blocks: [{ kind: 'audio', v: 1, id: 'voice-block', text: '你好。', url: '' }] } },
      },
    ],
  });
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  function Harness() {
    useVoiceAutoPlay();
    return null;
  }
  try {
    await act(async () => {
      root.render(<Harness />);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(streamTts).toHaveBeenCalledOnce();
    expect(
      useToastStore
        .getState()
        .toasts.filter(
          (toast) =>
            toast.message ===
            (changed === 'error' ? '参考音频在同一任务中发生变化，已停止后续语音。' : nextSelection.warnings[0]),
        ),
    ).toHaveLength(1);
  } finally {
    await act(async () => root.unmount());
    useVoiceSessionStore.getState().stop();
    useChatStore.setState({ messages: [] });
    host.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
});
