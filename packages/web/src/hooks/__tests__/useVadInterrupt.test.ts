import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useVoiceSessionStore } from '@/stores/voiceSessionStore';

vi.mock('@/utils/api-client', () => ({
  apiFetch: vi.fn().mockResolvedValue({ ok: true }),
}));

const mockStart = vi.fn().mockResolvedValue(undefined);
const mockPause = vi.fn().mockResolvedValue(undefined);
const mockDestroy = vi.fn().mockResolvedValue(undefined);

const mockVadInstance = {
  start: mockStart,
  pause: mockPause,
  destroy: mockDestroy,
  listening: false,
  errored: null,
};

vi.mock('@ricky0123/vad-web', () => ({
  MicVAD: {
    new: vi.fn(async () => {
      mockVadInstance.listening = false;
      mockStart.mockImplementation(async () => {
        mockVadInstance.listening = true;
      });
      mockPause.mockImplementation(async () => {
        mockVadInstance.listening = false;
      });
      return mockVadInstance;
    }),
  },
}));

function startVoiceSession() {
  useVoiceSessionStore.getState().start('thread-1', 'opus', true);
}

beforeEach(() => {
  useVoiceSessionStore.setState({ session: null });
  mockVadInstance.listening = false;
  vi.clearAllMocks();
});

describe('handleVadSpeechStart — unified interrupt via stopAllAudio', () => {
  it('calls stopAllAudio when playbackState is playing', async () => {
    const { handleVadSpeechStart } = await import('../useVadInterrupt');
    startVoiceSession();
    useVoiceSessionStore.getState().setPlaybackState('playing');

    const stopSpy = vi.fn();
    useVoiceSessionStore.getState().registerStopCallback('test', stopSpy);

    handleVadSpeechStart();

    expect(stopSpy).toHaveBeenCalledTimes(1);
  });

  it('does NOT call stopAllAudio when playbackState is idle', async () => {
    const { handleVadSpeechStart } = await import('../useVadInterrupt');
    startVoiceSession();
    useVoiceSessionStore.getState().setPlaybackState('idle');

    const stopSpy = vi.fn();
    useVoiceSessionStore.getState().registerStopCallback('test', stopSpy);

    handleVadSpeechStart();

    expect(stopSpy).not.toHaveBeenCalled();
  });

  it('does NOT call stopAllAudio when playbackState is paused', async () => {
    const { handleVadSpeechStart } = await import('../useVadInterrupt');
    startVoiceSession();
    useVoiceSessionStore.getState().setPlaybackState('paused');

    const stopSpy = vi.fn();
    useVoiceSessionStore.getState().registerStopCallback('test', stopSpy);

    handleVadSpeechStart();

    expect(stopSpy).not.toHaveBeenCalled();
  });

  it('invokes multiple registered stop callbacks', async () => {
    const { handleVadSpeechStart } = await import('../useVadInterrupt');
    startVoiceSession();
    useVoiceSessionStore.getState().setPlaybackState('playing');

    const stop1 = vi.fn();
    const stop2 = vi.fn();
    useVoiceSessionStore.getState().registerStopCallback('path-a', stop1);
    useVoiceSessionStore.getState().registerStopCallback('path-b', stop2);

    handleVadSpeechStart();

    expect(stop1).toHaveBeenCalledTimes(1);
    expect(stop2).toHaveBeenCalledTimes(1);
  });
});

describe('registerStopCallback — lifecycle', () => {
  it('unregister removes callback from future stopAllAudio calls', () => {
    startVoiceSession();
    const stopSpy = vi.fn();
    const unregister = useVoiceSessionStore.getState().registerStopCallback('temp', stopSpy);

    unregister();

    useVoiceSessionStore.getState().stopAllAudio();
    expect(stopSpy).not.toHaveBeenCalled();
  });

  it('re-registering same id replaces previous callback', () => {
    startVoiceSession();
    const old = vi.fn();
    const replacement = vi.fn();
    useVoiceSessionStore.getState().registerStopCallback('same-id', old);
    useVoiceSessionStore.getState().registerStopCallback('same-id', replacement);

    useVoiceSessionStore.getState().stopAllAudio();
    expect(old).not.toHaveBeenCalled();
    expect(replacement).toHaveBeenCalledTimes(1);
  });
});

describe('MicVAD lifecycle', () => {
  it('start() sets listening to true', async () => {
    const { MicVAD } = await import('@ricky0123/vad-web');
    const vad = await MicVAD.new({} as never);

    expect(vad.listening).toBe(false);
    await vad.start();
    expect(vad.listening).toBe(true);
  });

  it('pause() sets listening to false', async () => {
    const { MicVAD } = await import('@ricky0123/vad-web');
    const vad = await MicVAD.new({} as never);

    await vad.start();
    expect(vad.listening).toBe(true);
    await vad.pause();
    expect(vad.listening).toBe(false);
  });

  it('destroy() is callable', async () => {
    const { MicVAD } = await import('@ricky0123/vad-web');
    const vad = await MicVAD.new({} as never);

    await vad.destroy();
    expect(mockDestroy).toHaveBeenCalled();
  });
});

describe('voiceSessionStore integration', () => {
  it('session is null when voiceMode is off', () => {
    expect(useVoiceSessionStore.getState().session).toBeNull();
  });

  it('start() creates session with voiceMode=true', () => {
    startVoiceSession();
    expect(useVoiceSessionStore.getState().session?.voiceMode).toBe(true);
  });

  it('setPlaybackState tracks state transitions', () => {
    startVoiceSession();

    useVoiceSessionStore.getState().setPlaybackState('playing');
    expect(useVoiceSessionStore.getState().session?.playbackState).toBe('playing');

    useVoiceSessionStore.getState().setPlaybackState('idle');
    expect(useVoiceSessionStore.getState().session?.playbackState).toBe('idle');
  });

  it('stop() clears session to null', () => {
    startVoiceSession();
    useVoiceSessionStore.getState().stop();
    expect(useVoiceSessionStore.getState().session).toBeNull();
  });
});
