import { afterEach, describe, expect, it, vi } from 'vitest';

const manager = {
  destroy: vi.fn(),
  interrupt: vi.fn(),
  pause: vi.fn(),
  resume: vi.fn(),
  skip: vi.fn(),
  getActiveInvocationId: vi.fn((): string | null => null),
};

const unregisterStop = vi.fn();
const unregisterControls = vi.fn();
const voiceStore = {
  setPlaybackState: vi.fn(),
  registerStopCallback: vi.fn(() => unregisterStop),
  registerPlaybackControl: vi.fn(() => unregisterControls),
};

vi.mock('../PlaybackManager', () => ({
  PlaybackManager: vi.fn(function PlaybackManagerMock() {
    return manager;
  }),
}));

vi.mock('@/stores/voiceSessionStore', () => ({
  useVoiceSessionStore: {
    getState: () => voiceStore,
  },
}));

import { destroyPlaybackRuntime, getPlaybackManager, peekPlaybackManager } from '../playbackRuntime';

describe('F279 AppShell playback runtime', () => {
  afterEach(() => {
    destroyPlaybackRuntime();
    vi.clearAllMocks();
  });

  it('returns one process-level manager until the AppShell runtime is destroyed', () => {
    const first = getPlaybackManager();
    const second = getPlaybackManager();

    expect(second).toBe(first);
    expect(peekPlaybackManager()).toBe(first);
  });

  it('destroys the manager and unregisters voice controls only at runtime teardown', () => {
    getPlaybackManager();

    destroyPlaybackRuntime();

    expect(manager.destroy).toHaveBeenCalledOnce();
    expect(unregisterStop).toHaveBeenCalledOnce();
    expect(unregisterControls).toHaveBeenCalledOnce();
    expect(peekPlaybackManager()).toBeNull();
  });
});
