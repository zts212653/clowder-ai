// @vitest-environment jsdom

import type { ListenDocumentState } from '@cat-cafe/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ListenDocumentDescriptor } from '@/stores/listenModeStore';
import { listenDocumentCacheKey, useListenModeStore } from '@/stores/listenModeStore';
import { useVoiceSessionStore } from '@/stores/voiceSessionStore';
import { DocumentListenController } from '../DocumentListenController';
import type { EnqueueUrlResult, PlaybackSnapshot } from '../PlaybackManager';

function descriptor(): ListenDocumentDescriptor {
  return {
    identity: { projectPath: '/repo', relativePath: 'docs/research.md', contentDigest: 'sha-new' },
    title: 'research.md',
    worktreeId: 'cat-cafe',
    sentences: [0, 1, 2, 3, 4, 5].map((index) => ({
      anchor: `sentence-${index}`,
      occurrence: 0,
      index,
      text: `第 ${index + 1} 句。`,
      normalizedText: `第 ${index + 1} 句。`,
      sourceStart: index * 10,
      sourceEnd: index * 10 + 5,
      fragments: [{ start: index * 10, end: index * 10 + 5 }],
      container: 'paragraph' as const,
    })),
  };
}

function harness(saved: ListenDocumentState | null = null) {
  const telemetry = vi.fn();
  const fetchAudio = vi
    .fn<(url: string) => Promise<Response>>()
    .mockResolvedValue({ ok: true, blob: () => Promise.resolve(new Blob(['audio'])) } as Response);
  let snapshot: PlaybackSnapshot = {
    state: 'idle',
    source: null,
    itemIndex: 0,
    currentTime: 0,
    duration: 0,
    playbackRate: 1,
  };
  let snapshotListener: ((value: PlaybackSnapshot) => void) | null = null;
  let itemEndListener: ((index: number) => void) | null = null;
  const manager = {
    beginBatch: vi.fn(() => {
      snapshot = { ...snapshot, source: 'listen' as const, state: 'idle' as const, itemIndex: 0 };
    }),
    setPlaybackRate: vi.fn((rate: number) => {
      snapshot = { ...snapshot, playbackRate: rate };
    }),
    subscribe: vi.fn((listener: (value: PlaybackSnapshot) => void) => {
      snapshotListener = listener;
      listener(snapshot);
      return () => {
        snapshotListener = null;
      };
    }),
    onItemEnd: vi.fn((listener: (index: number) => void) => {
      itemEndListener = listener;
      return () => {
        itemEndListener = null;
      };
    }),
    enqueueUrl: vi
      .fn<(url: string, fetchFn: (url: string) => Promise<Response>) => Promise<EnqueueUrlResult>>()
      .mockImplementation(async () => {
        snapshot = { ...snapshot, state: 'playing' as const };
        snapshotListener?.(snapshot);
        return 'enqueued';
      }),
    enqueueBase64: vi.fn(() => {
      snapshot = { ...snapshot, state: 'playing' as const };
      snapshotListener?.(snapshot);
    }),
    markDone: vi.fn(),
    getSnapshot: vi.fn(() => snapshot),
    pause: vi.fn(),
    resume: vi.fn(),
    interrupt: vi.fn(),
    seek: vi.fn(),
  };
  const api = {
    load: vi.fn().mockResolvedValue(saved),
    save: vi.fn().mockResolvedValue(undefined),
    stream: vi.fn((text: string, signal?: AbortSignal) => {
      void signal;
      return (async function* () {
        yield { type: 'chunk' as const, audioBase64: 'AAAA', format: 'wav', durationSec: 0.5, isFinalChunk: true };
        yield {
          type: 'asset' as const,
          audioUrl: `/audio/${text}.wav`,
          assetId: `${text.padEnd(64, '0').slice(0, 64).replaceAll(' ', '0')}.wav`,
          cached: false,
          bytes: 100,
        };
      })();
    }),
    linkAsset: vi.fn().mockResolvedValue(undefined),
    startCache: vi.fn(),
    cancelCache: vi.fn(),
    clearAudio: vi.fn().mockResolvedValue(undefined),
  };
  const controller = new DocumentListenController({
    api,
    getManager: () => manager as never,
    fetchAudio,
    now: () => 123,
    telemetry,
  });
  return {
    api,
    controller,
    emitSnapshot: (patch: Partial<PlaybackSnapshot>) => {
      snapshot = { ...snapshot, ...patch };
      snapshotListener?.(snapshot);
    },
    fetchAudio,
    itemEnd: (index: number) => itemEndListener?.(index),
    manager,
    telemetry,
  };
}

describe('DocumentListenController', () => {
  beforeEach(() => useListenModeStore.setState({ session: null, cacheByDocument: {} }));

  it('queues one complete sentence asset and never exposes streamed WAV chunks as audible seams', async () => {
    let releaseAsset: (() => void) | undefined;
    const { api, controller, manager } = harness();
    api.stream.mockImplementationOnce(() =>
      (async function* () {
        yield { type: 'chunk' as const, audioBase64: 'A', format: 'wav', durationSec: 0.5, isFinalChunk: false };
        yield { type: 'chunk' as const, audioBase64: 'B', format: 'wav', durationSec: 0.5, isFinalChunk: false };
        yield { type: 'chunk' as const, audioBase64: 'C', format: 'wav', durationSec: 0.5, isFinalChunk: true };
        await new Promise<void>((resolve) => {
          releaseAsset = resolve;
        });
        yield {
          type: 'asset' as const,
          audioUrl: '/audio/buffered.wav',
          assetId: `${'f'.repeat(64)}.wav`,
          cached: false,
          bytes: 300,
        };
      })(),
    );

    await controller.startDocument(descriptor());
    await vi.waitFor(() => expect(releaseAsset).toBeTypeOf('function'));
    expect(manager.enqueueBase64).not.toHaveBeenCalled();
    expect(manager.enqueueUrl).not.toHaveBeenCalled();
    releaseAsset?.();
    await vi.waitFor(() => expect(api.linkAsset).toHaveBeenCalled());
    await vi.waitFor(() => expect(manager.enqueueUrl).toHaveBeenCalledWith('/audio/buffered.wav', expect.anything()));
    expect(manager.enqueueBase64).not.toHaveBeenCalled();
  });

  it('advances the existing shared cache projection as soon as a foreground asset links', async () => {
    const value = descriptor();
    const { api, controller, manager } = harness();
    api.linkAsset.mockResolvedValue(true);
    manager.enqueueUrl.mockResolvedValueOnce('failed');
    api.stream.mockImplementationOnce(() =>
      (async function* () {
        yield {
          type: 'asset' as const,
          audioUrl: '/audio/foreground.wav',
          assetId: `${'a'.repeat(64)}.wav`,
          cached: false,
          bytes: 100,
          synthesisFingerprint: 'fingerprint',
        };
      })(),
    );
    useListenModeStore.setState({
      cacheByDocument: {
        [listenDocumentCacheKey(value.identity)]: {
          identity: value.identity,
          synthesisFingerprint: 'fingerprint',
          cachedAnchors: [],
          cacheBytes: 0,
          totalSentences: value.sentences.length,
          active: true,
          error: null,
        },
      },
    });

    await controller.startDocument(value);

    await vi.waitFor(() =>
      expect(useListenModeStore.getState().cacheByDocument[listenDocumentCacheKey(value.identity)]).toMatchObject({
        cachedAnchors: ['sentence-0'],
        cacheBytes: 100,
        active: true,
        error: null,
      }),
    );
    await vi.waitFor(() => expect(useListenModeStore.getState().session?.phase).toBe('error'));
  });

  it('restores the stable saved anchor and only fills a bounded look-ahead window', async () => {
    const saved: ListenDocumentState = {
      identity: descriptor().identity,
      sentences: [{ anchor: 'sentence-2', assetId: `${'a'.repeat(64)}.wav` }],
      position: { anchor: 'sentence-2', offsetSeconds: 4 },
      playbackRate: 1.5,
      retention: '30d',
      updatedAt: 1,
    };
    const { api, controller, manager } = harness(saved);
    const stoppedExistingAudio = vi.fn();
    const unregisterStop = useVoiceSessionStore
      .getState()
      .registerStopCallback('f279-controller-test', stoppedExistingAudio);

    await controller.startDocument(descriptor());
    await vi.waitFor(() => expect(api.stream).toHaveBeenCalledTimes(4));

    expect(useListenModeStore.getState().session).toMatchObject({
      currentIndex: 2,
      playbackRate: 1.5,
      retention: '30d',
    });
    expect(manager.beginBatch).toHaveBeenCalledWith('listen');
    expect(manager.setPlaybackRate).toHaveBeenCalledWith(1.5);
    expect(manager.seek).toHaveBeenCalledWith(4);
    expect(stoppedExistingAudio).toHaveBeenCalledOnce();
    unregisterStop();
    expect(api.stream.mock.calls.map(([text]) => text)).toEqual(['第 3 句。', '第 4 句。', '第 5 句。', '第 6 句。']);
  });

  it('pauses independently playing rich audio before resuming listen playback', () => {
    const { controller, emitSnapshot, manager } = harness();
    const pauseRichAudio = vi.fn();
    const unregister = useVoiceSessionStore.getState().registerPlaybackControl('f279-rich-audio-test', {
      pause: pauseRichAudio,
      resume: vi.fn(),
      skip: vi.fn(),
    });
    useListenModeStore.setState({
      session: {
        ...descriptor(),
        phase: 'paused',
        currentIndex: 0,
        currentTime: 0,
        duration: 1,
        playbackRate: 1,
        retention: '7d',
        cachedAnchors: [],
        cacheBytes: 0,
        error: null,
      },
    });
    emitSnapshot({ source: 'listen', state: 'paused' });

    controller.togglePlayback();

    expect(pauseRichAudio).toHaveBeenCalledOnce();
    expect(manager.resume).toHaveBeenCalledOnce();
    expect(pauseRichAudio.mock.invocationCallOrder[0]).toBeLessThan(manager.resume.mock.invocationCallOrder[0]);
    unregister();
  });

  it('starts from an explicit sentence and advances the durable position when a sentence ends', async () => {
    const { api, controller, itemEnd } = harness();
    await controller.startDocument(descriptor(), 3);
    await vi.waitFor(() => expect(api.stream).toHaveBeenCalledTimes(3));

    itemEnd(0);
    await vi.waitFor(() =>
      expect(api.save).toHaveBeenLastCalledWith(
        expect.objectContaining({ position: expect.objectContaining({ anchor: 'sentence-4' }) }),
      ),
    );
    expect(useListenModeStore.getState().session?.currentIndex).toBe(4);
  });

  it('persists sentence-local progress while playback is active without saving every timeupdate', async () => {
    const { api, controller, emitSnapshot } = harness();
    await controller.startDocument(descriptor(), 1);
    await vi.waitFor(() => expect(api.stream).toHaveBeenCalledTimes(4));
    api.save.mockClear();

    emitSnapshot({ source: 'listen', state: 'playing', currentTime: 2.1, duration: 8 });
    emitSnapshot({ source: 'listen', state: 'playing', currentTime: 2.8, duration: 8 });
    await vi.waitFor(() => expect(api.save).toHaveBeenCalledTimes(1));

    expect(api.save).toHaveBeenLastCalledWith(
      expect.objectContaining({ position: { anchor: 'sentence-1', offsetSeconds: 2.1 } }),
    );
  });

  it('invalidates stale synthesis when another document takes ownership', async () => {
    let releaseFirst: (() => void) | undefined;
    const { api, controller, manager } = harness();
    api.stream.mockImplementationOnce(() =>
      (async function* () {
        await new Promise<void>((resolve) => {
          releaseFirst = resolve;
        });
        yield {
          type: 'asset' as const,
          audioUrl: '/old.wav',
          assetId: `${'b'.repeat(64)}.wav`,
          cached: false,
          bytes: 100,
        };
      })(),
    );
    const first = controller.startDocument(descriptor(), 0);
    await vi.waitFor(() => expect(api.stream).toHaveBeenCalledTimes(1));
    const replacement = { ...descriptor(), identity: { ...descriptor().identity, relativePath: 'docs/new.md' } };
    const second = controller.startDocument(replacement, 1);
    releaseFirst?.();
    await Promise.all([first, second]);
    await vi.waitFor(() => expect(manager.enqueueUrl).toHaveBeenCalled());

    expect(useListenModeStore.getState().session?.identity.relativePath).toBe('docs/new.md');
    expect(manager.enqueueUrl).not.toHaveBeenCalledWith('/old.wav', expect.anything());
  });

  it('aborts stale synthesis immediately when another document takes ownership', async () => {
    let firstSignal: AbortSignal | undefined;
    let releaseFirst: (() => void) | undefined;
    const { api, controller } = harness();
    api.stream.mockImplementationOnce((_text: string, signal?: AbortSignal) =>
      (async function* () {
        firstSignal = signal;
        await new Promise<void>((resolve) => {
          releaseFirst = resolve;
        });
        yield {
          type: 'asset' as const,
          audioUrl: '/stale.wav',
          assetId: `${'d'.repeat(64)}.wav`,
          cached: false,
          bytes: 100,
        };
      })(),
    );

    await controller.startDocument(descriptor(), 0);
    await vi.waitFor(() => expect(firstSignal).toBeDefined());
    const replacement = { ...descriptor(), identity: { ...descriptor().identity, relativePath: 'docs/new.md' } };
    await controller.startDocument(replacement, 1);
    const aborted = firstSignal?.aborted;
    releaseFirst?.();

    expect(aborted).toBe(true);
  });

  it('interrupts queued audio before exposing a synthesis failure', async () => {
    const { api, controller, manager } = harness();
    let interruptedWhenErrorBecameVisible = false;
    const unsubscribe = useListenModeStore.subscribe((state) => {
      if (state.session?.phase === 'error') interruptedWhenErrorBecameVisible = manager.interrupt.mock.calls.length > 0;
    });
    api.stream.mockImplementationOnce(() =>
      (async function* () {
        yield { type: 'chunk' as const, audioBase64: 'AAAA', format: 'wav', durationSec: 2, isFinalChunk: true };
        throw new Error('sidecar stream failed');
      })(),
    );

    await controller.startDocument(descriptor());
    await vi.waitFor(() => expect(useListenModeStore.getState().session?.phase).toBe('error'));

    expect(manager.interrupt).toHaveBeenCalledOnce();
    expect(interruptedWhenErrorBecameVisible).toBe(true);
    expect(useListenModeStore.getState().session?.error).toBe('sidecar stream failed');
    unsubscribe();
  });

  it.each([
    ['rejected fetch', () => Promise.reject(new TypeError('network error'))],
    ['404 response', () => Promise.resolve({ ok: false, status: 404 } as Response)],
  ])('%s leaves the complete asset unprepared and exposes retryable error', async (_label, failFetch) => {
    const { api, controller, fetchAudio, manager } = harness();
    fetchAudio.mockImplementationOnce(failFetch);
    manager.enqueueUrl.mockImplementationOnce(async (url, fetchFn) => {
      try {
        return (await fetchFn(url)).ok ? 'enqueued' : 'failed';
      } catch {
        return 'failed';
      }
    });

    await controller.startDocument(descriptor());
    await vi.waitFor(() => expect(useListenModeStore.getState().session?.phase).toBe('error'));

    expect(api.stream).toHaveBeenCalledTimes(1);
    expect(fetchAudio).toHaveBeenCalledOnce();
    expect(manager.enqueueUrl).toHaveBeenCalledTimes(1);
    expect(manager.markDone).not.toHaveBeenCalled();
    expect(manager.interrupt).toHaveBeenCalledOnce();
    expect(useListenModeStore.getState().session).toMatchObject({
      currentIndex: 0,
      cachedAnchors: [],
      cacheBytes: 0,
      phase: 'error',
      error: '完整音频加载失败，请重试',
    });
  });

  it('treats an interrupted in-flight prefetch as cancellation until the user resumes', async () => {
    let resolvePrefetch: ((result: 'cancelled') => void) | undefined;
    const { api, controller, emitSnapshot, manager } = harness();
    manager.enqueueUrl.mockResolvedValueOnce('enqueued').mockImplementationOnce(
      () =>
        new Promise<'cancelled'>((resolve) => {
          resolvePrefetch = resolve;
        }),
    );

    await controller.startDocument(descriptor());
    await vi.waitFor(() => expect(manager.enqueueUrl).toHaveBeenCalledTimes(2));
    emitSnapshot({ source: 'listen', state: 'playing' });

    manager.interrupt();
    emitSnapshot({ source: null, state: 'idle' });
    resolvePrefetch?.('cancelled');
    for (let index = 0; index < 10; index++) await Promise.resolve();

    expect(api.stream).toHaveBeenCalledTimes(2);
    expect(manager.enqueueUrl).toHaveBeenCalledTimes(2);
    expect(manager.markDone).not.toHaveBeenCalled();
    expect(useListenModeStore.getState().session).toMatchObject({
      currentIndex: 0,
      cachedAnchors: ['sentence-0'],
      cacheBytes: 100,
      phase: 'idle',
      error: null,
    });

    controller.togglePlayback();
    await vi.waitFor(() => expect(manager.beginBatch).toHaveBeenCalledTimes(2));
    expect(api.stream.mock.calls.length).toBeGreaterThan(2);
  });

  it('emits privacy-bounded first-play, buffer-depth, and underrun health metrics', async () => {
    const { controller, emitSnapshot, telemetry } = harness();

    await controller.startDocument(descriptor());
    await vi.waitFor(() =>
      expect(telemetry).toHaveBeenCalledWith(
        expect.objectContaining({
          feature: 'F279',
          metric: 'first_segment_ready_ms',
          contentDigest: 'sha-new',
          value: 0,
        }),
      ),
    );
    expect(telemetry).toHaveBeenCalledWith(
      expect.objectContaining({ metric: 'first_audio_play_ms', contentDigest: 'sha-new', value: 0 }),
    );
    expect(telemetry).toHaveBeenCalledWith(
      expect.objectContaining({ metric: 'prefetch_buffer_segments', contentDigest: 'sha-new', value: 3 }),
    );

    emitSnapshot({ source: 'listen', state: 'idle', itemIndex: 0 });
    emitSnapshot({ source: 'listen', state: 'idle', itemIndex: 0 });

    expect(telemetry).toHaveBeenCalledWith(
      expect.objectContaining({ metric: 'buffer_underrun_count', contentDigest: 'sha-new', value: 1 }),
    );
    expect(telemetry.mock.calls.filter(([event]) => event.metric === 'buffer_underrun_count')).toHaveLength(1);
    for (const [event] of telemetry.mock.calls) {
      expect(event).not.toHaveProperty('text');
      expect(event).not.toHaveProperty('projectPath');
      expect(event).not.toHaveProperty('relativePath');
    }
  });
});
