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

    await pm.enqueueUrl('/api/audio/1.wav', mockFetch);
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

    await pm.enqueueUrl('/api/audio/missing.wav', mockFetch);
    expect(pm.getState()).toBe('idle');
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

    // Segment 1 finishes, but segment 2 fetch is still pending
    // playNext() sees empty queue + streamDone=false → stays in playing state
    mockAudio.ended = true;
    mockAudio.onended?.();

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

    await pm.enqueueUrl('/audio/fail.wav', rejectingFetch);
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
