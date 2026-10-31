// @vitest-environment jsdom

import type { ListenDocumentState } from '@cat-cafe/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ListenDocumentDescriptor } from '@/stores/listenModeStore';
import { listenDocumentCacheKey, useListenModeStore } from '@/stores/listenModeStore';
import { DocumentCacheController } from '../DocumentCacheController';

function descriptor(): ListenDocumentDescriptor {
  return {
    identity: { projectPath: '/repo', relativePath: 'docs/cache.md', contentDigest: 'sha-current' },
    title: 'cache.md',
    worktreeId: 'cat-cafe',
    sentences: [0, 1, 2].map((index) => ({
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

function documentState(assetAnchors: string[] = []): ListenDocumentState {
  const value = descriptor();
  return {
    identity: value.identity,
    synthesisFingerprint: 'fingerprint',
    sentences: value.sentences.map(({ anchor }) => ({
      anchor,
      ...(assetAnchors.includes(anchor) ? { assetId: `${anchor}.wav` } : {}),
    })),
    position: { anchor: 'sentence-0', offsetSeconds: 4 },
    playbackRate: 1.5,
    retention: '30d',
    updatedAt: 10,
  };
}

function harness() {
  const api = {
    load: vi.fn(),
    save: vi.fn(),
    stream: vi.fn(),
    linkAsset: vi.fn(),
    startCache: vi.fn(),
    cancelCache: vi.fn(),
    clearAudio: vi.fn(),
  };
  const schedule = vi.fn();
  const clear = vi.fn();
  const controller = new DocumentCacheController({ api, now: () => 100, schedule, clear });
  return { api, controller, schedule, clear };
}

describe('DocumentCacheController', () => {
  beforeEach(() => useListenModeStore.setState({ session: null, cacheByDocument: {} }));

  it('persists only the manifest, then starts a server-owned cache run before playback exists', async () => {
    const { api, controller, schedule } = harness();
    api.load.mockResolvedValue(null);
    api.save.mockResolvedValue(documentState());
    api.startCache.mockResolvedValue({
      ...documentState(['sentence-0']),
      cache: { cachedSentences: 1, totalSentences: 3, totalBytes: 321 },
      cacheRun: { active: true },
    });

    await controller.start(descriptor());

    expect(api.save).toHaveBeenCalledWith(
      expect.objectContaining({
        identity: descriptor().identity,
        sentences: [{ anchor: 'sentence-0' }, { anchor: 'sentence-1' }, { anchor: 'sentence-2' }],
        position: { anchor: 'sentence-0', offsetSeconds: 0 },
        playbackRate: 1,
        retention: '7d',
      }),
    );
    expect(api.startCache).toHaveBeenCalledWith({
      identity: descriptor().identity,
      sentences: descriptor().sentences.map(({ anchor, text }) => ({ anchor, text })),
    });
    expect(useListenModeStore.getState().session).toBeNull();
    expect(Object.values(useListenModeStore.getState().cacheByDocument)[0]).toMatchObject({
      cachedAnchors: ['sentence-0'],
      cacheBytes: 321,
      totalSentences: 3,
      active: true,
      error: null,
    });
    expect(schedule).toHaveBeenCalledOnce();
  });

  it('starts a cache run from the saved continuation anchor', async () => {
    const { api, controller } = harness();
    const saved = { ...documentState(), position: { anchor: 'sentence-2', offsetSeconds: 4 } };
    api.load.mockResolvedValue(saved);
    api.save.mockResolvedValue(saved);
    api.startCache.mockResolvedValue({
      ...saved,
      cache: { cachedSentences: 0, totalSentences: 3, totalBytes: 0 },
      cacheRun: { active: true },
    });

    await controller.start(descriptor());

    expect(api.startCache).toHaveBeenCalledWith({
      identity: descriptor().identity,
      sentences: descriptor().sentences.map(({ anchor, text }) => ({ anchor, text })),
      startAnchor: 'sentence-2',
    });
  });

  it('projects restart state honestly without silently starting another cache run', async () => {
    const { api, controller, schedule } = harness();
    api.load.mockResolvedValue({
      ...documentState(['sentence-0']),
      cache: { cachedSentences: 1, totalSentences: 3, totalBytes: 321 },
      cacheRun: { active: false },
    });

    await controller.refresh(descriptor());

    expect(api.startCache).not.toHaveBeenCalled();
    expect(Object.values(useListenModeStore.getState().cacheByDocument)[0]).toMatchObject({
      cachedAnchors: ['sentence-0'],
      active: false,
      error: null,
    });
    expect(schedule).not.toHaveBeenCalled();
  });

  it('keeps a remote run alive when the Workspace view releases it, and only cancels on intent', async () => {
    const { api, controller } = harness();
    const value = descriptor();
    useListenModeStore.setState({
      cacheByDocument: {
        [listenDocumentCacheKey(value.identity)]: {
          identity: value.identity,
          synthesisFingerprint: 'fingerprint',
          cachedAnchors: ['sentence-0'],
          cacheBytes: 321,
          totalSentences: 3,
          active: true,
          error: null,
        },
      },
    });
    api.cancelCache.mockResolvedValue({
      ...documentState(['sentence-0']),
      cache: { cachedSentences: 1, totalSentences: 3, totalBytes: 321 },
      cacheRun: { active: false },
    });

    controller.release(descriptor());
    expect(api.cancelCache).not.toHaveBeenCalled();
    await controller.cancel(descriptor());

    expect(api.cancelCache).toHaveBeenCalledWith({
      projectPath: '/repo',
      relativePath: 'docs/cache.md',
      contentDigest: 'sha-current',
      synthesisFingerprint: 'fingerprint',
    });
  });

  it('keeps polling a live server-owned run after the Workspace view releases it', async () => {
    const { api, controller, schedule, clear } = harness();
    const value = descriptor();
    const callbacks: Array<() => void> = [];
    schedule.mockImplementation((callback: () => void) => {
      callbacks.push(callback);
      return callback;
    });
    api.load.mockResolvedValue({
      ...documentState(['sentence-0']),
      cache: { cachedSentences: 1, totalSentences: 3, totalBytes: 321 },
      cacheRun: { active: true },
    });

    await controller.refresh(value);
    controller.release(value);

    expect(clear).not.toHaveBeenCalled();
    expect(callbacks).toHaveLength(1);
    api.load.mockResolvedValue({
      ...documentState(['sentence-0', 'sentence-1']),
      cache: { cachedSentences: 2, totalSentences: 3, totalBytes: 642 },
      cacheRun: { active: true },
    });
    await callbacks[0]();

    expect(Object.values(useListenModeStore.getState().cacheByDocument)[0]).toMatchObject({
      cachedAnchors: ['sentence-0', 'sentence-1'],
      cacheBytes: 642,
      active: true,
    });
    expect(schedule).toHaveBeenCalledTimes(2);
  });

  it('keeps an active manifest projection and retries after a transient refresh failure', async () => {
    const { api, controller, schedule } = harness();
    const value = descriptor();
    const callbacks: Array<() => void> = [];
    schedule.mockImplementation((callback: () => void) => {
      callbacks.push(callback);
      return callback;
    });
    api.load
      .mockResolvedValueOnce({
        ...documentState(['sentence-0']),
        cache: { cachedSentences: 1, totalSentences: 3, totalBytes: 321 },
        cacheRun: { active: true },
      })
      .mockRejectedValueOnce(new TypeError('temporary network failure'))
      .mockResolvedValueOnce({
        ...documentState(['sentence-0', 'sentence-1']),
        cache: { cachedSentences: 2, totalSentences: 3, totalBytes: 642 },
        cacheRun: { active: true },
      });

    await controller.refresh(value);
    callbacks[0]();
    await vi.waitFor(() => expect(api.load).toHaveBeenCalledTimes(2));

    expect(useListenModeStore.getState().cacheByDocument[listenDocumentCacheKey(value.identity)]).toMatchObject({
      cachedAnchors: ['sentence-0'],
      cacheBytes: 321,
      active: true,
      error: null,
    });
    expect(schedule).toHaveBeenCalledTimes(2);

    callbacks[1]();
    await vi.waitFor(() =>
      expect(useListenModeStore.getState().cacheByDocument[listenDocumentCacheKey(value.identity)]).toMatchObject({
        cachedAnchors: ['sentence-0', 'sentence-1'],
        cacheBytes: 642,
        active: true,
      }),
    );
  });

  it('refreshes the authoritative fingerprint before a user-requested cancel', async () => {
    const { api, controller } = harness();
    api.load.mockResolvedValue({
      ...documentState(['sentence-0']),
      cache: { cachedSentences: 1, totalSentences: 3, totalBytes: 321 },
      cacheRun: { active: true },
    });
    api.cancelCache.mockResolvedValue({
      ...documentState(['sentence-0']),
      cache: { cachedSentences: 1, totalSentences: 3, totalBytes: 321 },
      cacheRun: { active: false },
    });

    await controller.cancel(descriptor());

    expect(api.load).toHaveBeenCalledWith({
      projectPath: '/repo',
      relativePath: 'docs/cache.md',
      contentDigest: 'sha-current',
    });
    expect(api.cancelCache).toHaveBeenCalledWith({
      projectPath: '/repo',
      relativePath: 'docs/cache.md',
      contentDigest: 'sha-current',
      synthesisFingerprint: 'fingerprint',
    });
  });
});
