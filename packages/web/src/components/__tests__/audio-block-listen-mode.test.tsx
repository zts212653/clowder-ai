// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const manager = {
  getSnapshot: vi.fn(() => ({ source: 'listen', state: 'playing' })),
  pause: vi.fn(),
  interrupt: vi.fn(),
};

vi.mock('@/services/playbackRuntime', () => ({ peekPlaybackManager: () => manager }));

import { AudioBlock } from '@/components/rich/AudioBlock';
import { useListenModeStore } from '@/stores/listenModeStore';
import { useVoiceSessionStore } from '@/stores/voiceSessionStore';

describe('AudioBlock listen-mode coexistence', () => {
  let container: HTMLDivElement;
  let root: Root;
  const play = vi.fn().mockResolvedValue(undefined);
  const pause = vi.fn();

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.clearAllMocks();
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(play);
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(pause);
    useListenModeStore.setState({
      session: {
        identity: { projectPath: '/repo', relativePath: 'docs/research.md', contentDigest: 'sha' },
        title: 'research.md',
        worktreeId: null,
        sentences: [],
        phase: 'playing',
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
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    useListenModeStore.setState({ session: null });
    vi.restoreAllMocks();
  });

  it('explains suppressed autoplay and pauses the document before manual playback', async () => {
    await act(async () => {
      root.render(
        <AudioBlock
          block={{ id: 'voice-1', kind: 'audio', v: 1, url: '/uploads/voice.wav', text: '猫猫回复。' }}
          catId="codex"
        />,
      );
    });

    expect(container.textContent).toContain('听读中未自动播放');
    const button = container.querySelector('button');
    await act(async () => button?.click());

    expect(manager.pause).toHaveBeenCalledOnce();
    expect(manager.interrupt).not.toHaveBeenCalled();
    expect(play).toHaveBeenCalledOnce();

    act(() => useVoiceSessionStore.getState().pauseAudio());
    expect(pause).toHaveBeenCalledOnce();
  });
});
