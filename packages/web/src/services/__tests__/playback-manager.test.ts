import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let PlaybackManager: typeof import('../PlaybackManager').PlaybackManager;
type PlaybackManagerCallbacks = import('../PlaybackManager').PlaybackManagerCallbacks;
type PlaybackManagerState = import('../PlaybackManager').PlaybackManagerState;

let mockAudio: {
  src: string;
  play: ReturnType<typeof vi.fn>;
  pause: ReturnType<typeof vi.fn>;
  onended: (() => void) | null;
  onerror: (() => void) | null;
  ended: boolean;
  currentTime: number;
  duration: number;
  playbackRate: number;
  ontimeupdate: (() => void) | null;
  ondurationchange: (() => void) | null;
  onloadedmetadata: (() => void) | null;
  readyState: number;
  removeAttribute: ReturnType<typeof vi.fn>;
  preload: string;
  id: string;
  style: Record<string, string>;
};

function createMockAudio() {
  let _src = '';
  const audio = {
    get src() {
      return _src;
    },
    set src(v: string) {
      _src = v;
      if (v) audio.ended = false;
    },
    play: vi.fn(() => Promise.resolve()),
    pause: vi.fn(),
    onended: null as (() => void) | null,
    onerror: null as (() => void) | null,
    ended: false,
    currentTime: 0,
    duration: 10,
    playbackRate: 1,
    ontimeupdate: null as (() => void) | null,
    ondurationchange: null as (() => void) | null,
    onloadedmetadata: null as (() => void) | null,
    readyState: 1,
    removeAttribute: vi.fn((attr: string) => {
      if (attr === 'src') {
        _src = '';
      }
    }),
    preload: '',
    id: '',
    style: {} as Record<string, string>,
  };
  return audio;
}

beforeEach(async () => {
  vi.resetModules();
  mockAudio = createMockAudio();
  vi.spyOn(document, 'createElement').mockReturnValue(mockAudio as unknown as HTMLElement);
  vi.spyOn(document.body, 'appendChild').mockImplementation(() => mockAudio as unknown as HTMLElement);
  vi.spyOn(URL, 'createObjectURL').mockImplementation((blob) => `blob:${(blob as Blob).size ?? 'mock'}`);
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  vi.spyOn(globalThis, 'atob').mockImplementation((s) => s);
  const mod = await import('../PlaybackManager');
  PlaybackManager = mod.PlaybackManager;
});

afterEach(() => {
  vi.restoreAllMocks();
});

function makeCallbacks(): PlaybackManagerCallbacks & { states: PlaybackManagerState[] } {
  const states: PlaybackManagerState[] = [];
  return {
    states,
    onStateChange: (state) => states.push(state),
  };
}

function streamStart(invocationId = 'inv-1') {
  return { type: 'voice_stream_start' as const, invocationId, threadId: 't1', catId: 'opus' };
}

function chunk(invocationId = 'inv-1', index = 0) {
  return {
    type: 'voice_chunk' as const,
    invocationId,
    threadId: 't1',
    catId: 'opus',
    audioBase64: 'AAAA',
    index,
    format: 'mp3',
    text: 'hi',
  };
}

describe('PlaybackManager — existing behavior', () => {
  it('starts idle', () => {
    const cb = makeCallbacks();
    const pm = new PlaybackManager(cb);
    expect(pm.getState()).toBe('idle');
  });

  it('plays first chunk immediately', () => {
    const cb = makeCallbacks();
    const pm = new PlaybackManager(cb);
    pm.handleStreamStart(streamStart());
    pm.handleChunk(chunk());
    expect(pm.getState()).toBe('playing');
    expect(mockAudio.play).toHaveBeenCalled();
  });

  it('pause and resume work', () => {
    const cb = makeCallbacks();
    const pm = new PlaybackManager(cb);
    pm.handleStreamStart(streamStart());
    pm.handleChunk(chunk());
    expect(pm.getState()).toBe('playing');

    pm.pause();
    expect(pm.getState()).toBe('paused');
    expect(mockAudio.pause).toHaveBeenCalled();

    pm.resume();
    expect(pm.getState()).toBe('playing');
  });

  it('interrupt clears queue and goes idle', () => {
    const cb = makeCallbacks();
    const pm = new PlaybackManager(cb);
    pm.handleStreamStart(streamStart());
    pm.handleChunk(chunk());
    pm.interrupt();
    expect(pm.getState()).toBe('idle');
    expect(pm.getActiveInvocationId()).toBeNull();
  });
});

describe('PlaybackManager — enqueueUrl', () => {
  it('fetches URL and plays when idle', async () => {
    const cb = makeCallbacks();
    const pm = new PlaybackManager(cb);
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      blob: () => Promise.resolve(new Blob(['audio'], { type: 'audio/wav' })),
    });

    await expect(pm.enqueueUrl('/api/audio/1.wav', mockFetch)).resolves.toBe('enqueued');
    expect(mockFetch).toHaveBeenCalledWith('/api/audio/1.wav');
    expect(pm.getState()).toBe('playing');
    expect(mockAudio.play).toHaveBeenCalled();
  });

  it('queues URL when already playing', async () => {
    const cb = makeCallbacks();
    const pm = new PlaybackManager(cb);
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      blob: () => Promise.resolve(new Blob(['audio'], { type: 'audio/wav' })),
    });

    await pm.enqueueUrl('/api/audio/1.wav', mockFetch);
    expect(pm.getState()).toBe('playing');

    await pm.enqueueUrl('/api/audio/2.wav', mockFetch);
    // Still playing first URL, second is queued
    expect(pm.getState()).toBe('playing');
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('handles fetch failure gracefully', async () => {
    const cb = makeCallbacks();
    const pm = new PlaybackManager(cb);
    const mockFetch = vi.fn().mockResolvedValue({ ok: false, status: 404 });

    await expect(pm.enqueueUrl('/api/audio/missing.wav', mockFetch)).resolves.toBe('failed');
    expect(pm.getState()).toBe('idle');
  });

  it('distinguishes an interrupted in-flight fetch from a transfer failure', async () => {
    const cb = makeCallbacks();
    const pm = new PlaybackManager(cb);
    let resolveFetch: ((response: Response) => void) | undefined;
    const mockFetch = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        }),
    );

    const pending = pm.enqueueUrl('/api/audio/prefetch.wav', mockFetch);
    await vi.waitFor(() => expect(resolveFetch).toBeTypeOf('function'));
    pm.interrupt();
    resolveFetch?.({
      ok: true,
      blob: () => Promise.resolve(new Blob(['audio'], { type: 'audio/wav' })),
    } as Response);

    await expect(pending).resolves.toBe('cancelled');
    expect(pm.getState()).toBe('idle');
    expect(mockAudio.play).not.toHaveBeenCalled();
  });

  it('treats a fetch rejection from an interrupted batch as cancellation', async () => {
    const cb = makeCallbacks();
    const pm = new PlaybackManager(cb);
    pm.beginBatch('listen');
    let rejectFetch: ((reason?: unknown) => void) | undefined;
    const mockFetch = vi.fn(
      () =>
        new Promise<Response>((_resolve, reject) => {
          rejectFetch = reject;
        }),
    );

    const pending = pm.enqueueUrl('/api/audio/prefetch.wav', mockFetch);
    await vi.waitFor(() => expect(rejectFetch).toBeTypeOf('function'));
    pm.beginBatch('podcast');
    rejectFetch?.(new TypeError('aborted request'));

    await expect(pending).resolves.toBe('cancelled');
    expect(pm.getSnapshot()).toMatchObject({ source: 'podcast', state: 'idle' });
    expect(pm.isBatchActive()).toBe(true);
    expect(mockAudio.play).not.toHaveBeenCalled();
  });

  it('treats a blob rejection from an interrupted batch as cancellation', async () => {
    const cb = makeCallbacks();
    const pm = new PlaybackManager(cb);
    pm.beginBatch('listen');
    let rejectBlob: ((reason?: unknown) => void) | undefined;
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      blob: () =>
        new Promise<Blob>((_resolve, reject) => {
          rejectBlob = reject;
        }),
    });

    const pending = pm.enqueueUrl('/api/audio/prefetch.wav', mockFetch);
    await vi.waitFor(() => expect(rejectBlob).toBeTypeOf('function'));
    pm.handleStreamStart(streamStart('replacement-voice'));
    rejectBlob?.(new TypeError('aborted body'));

    await expect(pending).resolves.toBe('cancelled');
    expect(pm.getSnapshot()).toMatchObject({ source: 'voice', state: 'idle' });
    expect(pm.getActiveInvocationId()).toBe('replacement-voice');
    expect(mockAudio.play).not.toHaveBeenCalled();
  });
});

describe('PlaybackManager — startBatch', () => {
  it('interrupts existing playback and starts batch', async () => {
    const cb = makeCallbacks();
    const pm = new PlaybackManager(cb);
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      blob: () => Promise.resolve(new Blob(['audio'], { type: 'audio/wav' })),
    });

    // Start voice stream first
    pm.handleStreamStart(streamStart());
    pm.handleChunk(chunk());
    expect(pm.getState()).toBe('playing');

    // Start batch — should interrupt voice
    await pm.startBatch(['/audio/1.wav', '/audio/2.wav'], mockFetch);
    expect(pm.getActiveInvocationId()).toBeNull();
    expect(pm.getState()).toBe('playing');
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('fires onItemEnd callbacks during batch', async () => {
    const cb = makeCallbacks();
    const pm = new PlaybackManager(cb);
    const itemEnds: number[] = [];

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      blob: () => Promise.resolve(new Blob(['audio'], { type: 'audio/wav' })),
    });

    const unsub = pm.onItemEnd((index) => itemEnds.push(index));

    await pm.startBatch(['/audio/1.wav', '/audio/2.wav', '/audio/3.wav'], mockFetch);

    // Simulate first item ending
    mockAudio.ended = true;
    mockAudio.onended?.();
    expect(itemEnds).toEqual([0]);

    // Second item ending
    mockAudio.onended?.();
    expect(itemEnds).toEqual([0, 1]);

    // Third (last) item ending → idle
    mockAudio.onended?.();
    expect(itemEnds).toEqual([0, 1, 2]);
    expect(pm.getState()).toBe('idle');

    unsub();
  });

  it('isBatchActive returns correct state', async () => {
    const cb = makeCallbacks();
    const pm = new PlaybackManager(cb);
    expect(pm.isBatchActive()).toBe(false);

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      blob: () => Promise.resolve(new Blob(['audio'], { type: 'audio/wav' })),
    });

    await pm.startBatch(['/audio/1.wav'], mockFetch);
    expect(pm.isBatchActive()).toBe(true);

    // Complete the batch
    mockAudio.onended?.();
    expect(pm.isBatchActive()).toBe(false);
  });
});

describe('PlaybackManager — markDone', () => {
  it('transitions to idle after current item when marked done', async () => {
    const cb = makeCallbacks();
    const pm = new PlaybackManager(cb);
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      blob: () => Promise.resolve(new Blob(['audio'], { type: 'audio/wav' })),
    });

    await pm.enqueueUrl('/audio/1.wav', mockFetch);
    expect(pm.getState()).toBe('playing');

    pm.markDone();

    // Audio finishes playing
    mockAudio.onended?.();
    expect(pm.getState()).toBe('idle');
  });
});

describe('PlaybackManager — onStateIdle', () => {
  it('fires callback when transitioning to idle', async () => {
    const cb = makeCallbacks();
    const pm = new PlaybackManager(cb);
    let idleFired = false;

    const unsub = pm.onStateIdle(() => {
      idleFired = true;
    });

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      blob: () => Promise.resolve(new Blob(['audio'], { type: 'audio/wav' })),
    });

    await pm.enqueueUrl('/audio/1.wav', mockFetch);
    pm.markDone();
    mockAudio.onended?.();

    expect(idleFired).toBe(true);
    unsub();
  });

  it('unsubscribe stops callback', async () => {
    const cb = makeCallbacks();
    const pm = new PlaybackManager(cb);
    let callCount = 0;

    const unsub = pm.onStateIdle(() => {
      callCount++;
    });

    unsub();

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      blob: () => Promise.resolve(new Blob(['audio'], { type: 'audio/wav' })),
    });

    await pm.enqueueUrl('/audio/1.wav', mockFetch);
    pm.markDone();
    mockAudio.onended?.();

    expect(callCount).toBe(0);
  });
});

describe('PlaybackManager — P1 regression: stale fetch cancellation', () => {
  it('stop during active batch does not revive playback from in-flight fetches', async () => {
    const cb = makeCallbacks();
    const pm = new PlaybackManager(cb);

    let resolveSecondFetch!: (v: Response) => void;
    const secondFetchPromise = new Promise<Response>((r) => {
      resolveSecondFetch = r;
    });

    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        blob: () => Promise.resolve(new Blob(['seg1'], { type: 'audio/wav' })),
      })
      .mockReturnValueOnce(secondFetchPromise);

    const batchPromise = pm.startBatch(['/audio/1.wav', '/audio/2.wav'], mockFetch);

    // First enqueue resolves immediately → playing segment 1
    await vi.waitFor(() => expect(pm.getState()).toBe('playing'));

    // Interrupt while second fetch is still in flight
    pm.interrupt();
    expect(pm.getState()).toBe('idle');

    // Now the second fetch resolves — should be discarded (stale batchId)
    resolveSecondFetch({
      ok: true,
      blob: () => Promise.resolve(new Blob(['seg2'], { type: 'audio/wav' })),
    } as Response);

    await batchPromise;

    // State must remain idle — no revival
    expect(pm.getState()).toBe('idle');
    expect(mockAudio.play).toHaveBeenCalledTimes(1);
  });

  it('fast switch from batch A to batch B discards A stale returns', async () => {
    const cb = makeCallbacks();
    const pm = new PlaybackManager(cb);

    let resolveA2!: (v: Response) => void;
    const a2Promise = new Promise<Response>((r) => {
      resolveA2 = r;
    });

    const okBlob = (label: string) => ({
      ok: true,
      blob: () => Promise.resolve(new Blob([label], { type: 'audio/wav' })),
    });

    const fetchA = vi.fn().mockResolvedValueOnce(okBlob('a1')).mockReturnValueOnce(a2Promise);

    const batchAPromise = pm.startBatch(['/a/1.wav', '/a/2.wav'], fetchA);

    await vi.waitFor(() => expect(pm.getState()).toBe('playing'));

    // Start batch B before batch A's second fetch resolves
    const fetchB = vi.fn().mockResolvedValue(okBlob('b1'));
    const batchBPromise = pm.startBatch(['/b/1.wav'], fetchB);
    await batchBPromise;

    // Now resolve batch A's stale second fetch
    resolveA2(okBlob('a2-stale') as unknown as Response);
    await batchAPromise;

    // B should be playing, and play should have been called for b1 (not a2-stale)
    expect(pm.getState()).toBe('playing');
    // play calls: a1 (batch A), then interrupt resets, then b1 (batch B) = exactly 2
    // a2-stale should NOT have triggered a third play
    expect(mockAudio.play).toHaveBeenCalledTimes(2);
  });

  it('slow fetch between segments auto-resumes when blob arrives after audio ends', async () => {
    const cb = makeCallbacks();
    const pm = new PlaybackManager(cb);

    let resolveSecondFetch!: (v: Response) => void;
    const secondFetchPromise = new Promise<Response>((r) => {
      resolveSecondFetch = r;
    });

    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        blob: () => Promise.resolve(new Blob(['seg1'], { type: 'audio/wav' })),
      })
      .mockReturnValueOnce(secondFetchPromise);

    const batchPromise = pm.startBatch(['/audio/1.wav', '/audio/2.wav'], mockFetch);

    // Segment 1 starts playing
    await vi.waitFor(() => expect(pm.getState()).toBe('playing'));

    // Segment 1 finishes, but segment 2 fetch is still pending. The manager
    // must tell consumers that no audio is currently playing while retaining
    // batch ownership so the next blob can resume automatically.
    mockAudio.ended = true;
    mockAudio.onended?.();
    expect(pm.getSnapshot()).toMatchObject({ source: 'podcast', state: 'idle' });
    expect(pm.isBatchActive()).toBe(true);

    // Now resolve the second fetch — should auto-resume (audio.ended detected)
    resolveSecondFetch({
      ok: true,
      blob: () => Promise.resolve(new Blob(['seg2'], { type: 'audio/wav' })),
    } as Response);

    await batchPromise;

    // play() should have been called twice: once for seg1, once for seg2 (auto-resume)
    expect(mockAudio.play).toHaveBeenCalledTimes(2);
    expect(pm.getState()).toBe('playing');
  });
});

describe('PlaybackManager — P1 regression: fetch rejection handling', () => {
  it('enqueueUrl swallows fetch rejection and stays idle', async () => {
    const cb = makeCallbacks();
    const pm = new PlaybackManager(cb);
    const rejectingFetch = vi.fn().mockRejectedValue(new TypeError('network error'));

    await expect(pm.enqueueUrl('/audio/fail.wav', rejectingFetch)).resolves.toBe('failed');
    expect(pm.getState()).toBe('idle');
  });

  it('startBatch completes without throwing when one fetch rejects', async () => {
    const cb = makeCallbacks();
    const pm = new PlaybackManager(cb);

    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        blob: () => Promise.resolve(new Blob(['seg1'], { type: 'audio/wav' })),
      })
      .mockRejectedValueOnce(new TypeError('network error'))
      .mockResolvedValueOnce({
        ok: true,
        blob: () => Promise.resolve(new Blob(['seg3'], { type: 'audio/wav' })),
      });

    await pm.startBatch(['/a/1.wav', '/a/2.wav', '/a/3.wav'], mockFetch);

    expect(pm.getState()).toBe('playing');
    expect(mockAudio.play).toHaveBeenCalled();
  });

  it('startBatch with all fetches rejecting leaves state idle', async () => {
    const cb = makeCallbacks();
    const pm = new PlaybackManager(cb);
    const rejectingFetch = vi.fn().mockRejectedValue(new TypeError('offline'));

    await pm.startBatch(['/a/1.wav', '/a/2.wav'], rejectingFetch);

    expect(pm.getState()).toBe('idle');
  });
});

describe('PlaybackManager — F279 source, rate, and progress', () => {
  it('plays streamed chunks as one logical sentence boundary with cumulative progress', () => {
    const itemEnds: number[] = [];
    const pm = new PlaybackManager({
      ...makeCallbacks(),
      onItemEnd: (index) => itemEnds.push(index),
    });
    pm.beginBatch('listen');

    pm.enqueueBase64('AAAA', 'wav', { completesItem: false, durationSec: 0.5 });
    pm.enqueueBase64('BBBB', 'wav', { completesItem: true, durationSec: 0.5 });
    mockAudio.currentTime = 0.4;
    expect(pm.getSnapshot()).toMatchObject({ itemIndex: 0, currentTime: 0.4, duration: 1 });

    mockAudio.onended?.();
    expect(itemEnds).toEqual([]);
    mockAudio.currentTime = 0.25;
    expect(pm.getSnapshot()).toMatchObject({ itemIndex: 0, currentTime: 0.75, duration: 1 });

    mockAudio.onended?.();
    expect(itemEnds).toEqual([0]);
    expect(pm.getSnapshot().itemIndex).toBe(1);
  });

  it('owns a listen batch, applies playback rate, and publishes progress snapshots', async () => {
    const pm = new PlaybackManager(makeCallbacks());
    const snapshots: Array<ReturnType<typeof pm.getSnapshot>> = [];
    const unsubscribe = pm.subscribe((snapshot) => snapshots.push(snapshot));
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      blob: () => Promise.resolve(new Blob(['audio'], { type: 'audio/wav' })),
    });

    pm.beginBatch('listen');
    pm.setPlaybackRate(1.5);
    await pm.enqueueUrl('/audio/listen.wav', mockFetch);
    mockAudio.currentTime = 3;
    mockAudio.duration = 12;
    mockAudio.ontimeupdate?.();

    expect(pm.getSnapshot()).toMatchObject({
      source: 'listen',
      state: 'playing',
      playbackRate: 1.5,
      currentTime: 3,
      duration: 12,
      itemIndex: 0,
    });
    expect(mockAudio.playbackRate).toBe(1.5);
    expect(snapshots.at(-1)?.currentTime).toBe(3);
    unsubscribe();
  });

  it('seeks within the active sentence and publishes the resumed offset', async () => {
    const pm = new PlaybackManager(makeCallbacks());
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      blob: () => Promise.resolve(new Blob(['audio'], { type: 'audio/wav' })),
    });
    pm.beginBatch('listen');
    await pm.enqueueUrl('/audio/listen.wav', mockFetch);

    pm.seek(4);

    expect(mockAudio.currentTime).toBe(4);
    expect(pm.getSnapshot().currentTime).toBe(4);
  });

  it('replaces a listen owner when a voice stream starts', async () => {
    const pm = new PlaybackManager(makeCallbacks());
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      blob: () => Promise.resolve(new Blob(['audio'], { type: 'audio/wav' })),
    });
    pm.beginBatch('listen');
    await pm.enqueueUrl('/audio/listen.wav', mockFetch);

    pm.handleStreamStart(streamStart('voice-2'));
    pm.handleChunk(chunk('voice-2'));

    expect(pm.getSnapshot().source).toBe('voice');
    expect(pm.getActiveInvocationId()).toBe('voice-2');
    expect(mockAudio.play).toHaveBeenCalledTimes(2);
  });
});
