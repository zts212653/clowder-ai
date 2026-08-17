import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const manager = {
  destroy: vi.fn(),
  interrupt: vi.fn(),
  pause: vi.fn(),
  resume: vi.fn(),
  skip: vi.fn(),
  getActiveInvocationId: vi.fn((): string | null => 'voice-invocation'),
  getSnapshot: vi.fn(() => ({ source: 'voice' as 'voice' | 'listen' | null })),
  handleStreamStart: vi.fn(),
  handleChunk: vi.fn(),
  handleStreamEnd: vi.fn(),
};

vi.mock('@/services/playbackRuntime', () => ({
  getPlaybackManager: () => manager,
  peekPlaybackManager: () => manager,
}));

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn(() => Promise.resolve(new Response())) }));

import { useListenModeStore } from '@/stores/listenModeStore';
import { useVoiceSessionStore } from '@/stores/voiceSessionStore';
import { handleVoiceStreamStart, useVoiceStream } from '../useVoiceStream';

function Harness() {
  useVoiceStream();
  return null;
}

describe('F279 voice hook lifecycle', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.clearAllMocks();
    useVoiceSessionStore.setState({
      session: {
        sessionId: 'voice-session',
        boundThreadId: 'thread-1',
        activeCatId: 'opus',
        voiceMode: true,
        autoplayUnlocked: true,
        playbackState: 'playing',
        playedBlockIds: new Set(),
        liveStreamActive: true,
        liveStreamedInvocationIds: new Set(['voice-invocation']),
      },
    });
    useListenModeStore.setState({ session: null });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    useVoiceSessionStore.setState({ session: null });
    useListenModeStore.setState({ session: null });
  });

  it('does not destroy the shared playback runtime when ChatContainer unmounts', async () => {
    await act(async () => root.render(<Harness />));
    act(() => root.unmount());

    expect(manager.destroy).not.toHaveBeenCalled();
    expect(manager.interrupt).not.toHaveBeenCalled();
  });

  it('interrupts only an active voice invocation when Voice Mode turns off', async () => {
    await act(async () => root.render(<Harness />));
    manager.getActiveInvocationId.mockReturnValueOnce(null);
    act(() => useVoiceSessionStore.setState({ session: null }));
    expect(manager.interrupt).not.toHaveBeenCalled();

    manager.getActiveInvocationId.mockReturnValueOnce('voice-invocation');
    act(() =>
      useVoiceSessionStore.setState({
        session: {
          sessionId: 'voice-session-2',
          boundThreadId: 'thread-1',
          activeCatId: 'opus',
          voiceMode: false,
          autoplayUnlocked: true,
          playbackState: 'playing',
          playedBlockIds: new Set(),
          liveStreamActive: true,
          liveStreamedInvocationIds: new Set(['voice-invocation']),
        },
      }),
    );
    expect(manager.interrupt).toHaveBeenCalledOnce();
  });

  it('suppresses automatic cat voice while a listen session remains active', () => {
    manager.getSnapshot.mockReturnValueOnce({ source: 'voice' });
    useListenModeStore.setState({
      session: {
        identity: { projectPath: '/repo', relativePath: 'docs/research.md', contentDigest: 'sha' },
        title: 'research.md',
        worktreeId: null,
        sentences: [],
        phase: 'paused',
        currentIndex: 0,
        currentTime: 0,
        duration: 0,
        playbackRate: 1,
        retention: '7d',
        cachedAnchors: [],
        cacheBytes: 0,
        error: null,
      },
    });

    handleVoiceStreamStart({ threadId: 'thread-1', catId: 'opus', invocationId: 'voice-new' } as never);

    expect(manager.handleStreamStart).not.toHaveBeenCalled();
  });
});
