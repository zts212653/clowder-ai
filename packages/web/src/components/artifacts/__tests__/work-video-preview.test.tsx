import { FEATURE_DEMOS, type ThreadArtifactDTO } from '@cat-cafe/shared';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { WorkGalleryCard } from '../WorkGalleryCard';

const callbacks: IntersectionObserverCallback[] = [];
const fetcher = vi.fn();
vi.mock('@/utils/api-client', () => ({
  API_URL: 'http://localhost:3102',
  apiFetch: (...args: unknown[]) => fetcher(...args),
}));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.clearAllMocks();
  callbacks.length = 0;
});

it('preserves the image cover and its original image fallback without a document badge', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const host = document.createElement('div'),
    root = createRoot(host);
  const artifact: ThreadArtifactDTO = {
    type: 'image',
    name: '画稿.png',
    url: '/uploads/art.png',
    catId: null,
    createdAt: 1,
    sourceMessageId: null,
  };
  try {
    await act(async () => root.render(<WorkGalleryCard artifact={artifact} onSelect={vi.fn()} />));
    expect(host.querySelector('img')?.alt).toBe('画稿.png');
    expect(host.querySelector('.work-cover-badge')).toBeNull();
    await act(async () => host.querySelector('img')?.dispatchEvent(new Event('error')));
    expect(host.textContent).toContain('图片');
    expect(host.querySelector('.work-cover-paper')).toBeNull();
  } finally {
    await act(async () => root.unmount());
  }
});

it('shows the exact registered poster and duration without requesting video', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const create = vi.spyOn(document, 'createElement');
  const reference = { contentRef: `work:${'a'.repeat(64)}`, ownerRevision: 1, currentOwnerRevision: 1 };
  const demo = FEATURE_DEMOS['conversation-proposals-v1'];
  if (!demo) throw new Error('Published demo fixture missing');
  fetcher.mockResolvedValue({
    ok: true,
    json: async () => ({
      asset: { ...reference, mediaType: 'video/mp4', blobDigest: `sha256:${demo.sha256}` },
      currentOwnerRevision: 1,
    }),
  });
  const host = document.createElement('div'),
    root = createRoot(host);
  try {
    await act(async () =>
      root.render(
        <WorkGalleryCard
          artifact={{
            type: 'video',
            name: '名字不参与封面匹配',
            url: '/uploads/cut.mp4',
            catId: 'opus55',
            createdAt: 1,
            sourceMessageId: null,
            work: reference,
          }}
          onSelect={vi.fn()}
        />,
      ),
    );
    expect(create.mock.calls.filter(([tag]) => tag === 'video')).toHaveLength(0);
    expect(host.textContent).toContain('0:48');
    expect(host.querySelector('.work-cover-poster')?.getAttribute('src')).toBe(demo.poster);
  } finally {
    await act(async () => root.unmount());
  }
});

it('requests a frame only on screen and keeps the captured image after releasing the reader', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      constructor(callback: IntersectionObserverCallback) {
        callbacks.push(callback);
      }
      observe() {}
      disconnect() {}
      unobserve() {}
    },
  );
  let video: HTMLVideoElement | undefined;
  const create = document.createElement.bind(document);
  vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
    const node = create(tag);
    if (node instanceof HTMLVideoElement) video = node;
    return node;
  });
  const unload = vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {});
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    drawImage: vi.fn(),
  } as unknown as CanvasRenderingContext2D);
  const artifact: ThreadArtifactDTO = {
    type: 'video',
    name: '真实成片.mp4',
    url: '/uploads/film.mp4',
    catId: 'opus55',
    createdAt: 1,
    sourceMessageId: 'message',
  };
  const host = document.createElement('div'),
    root = createRoot(host);
  try {
    await act(async () => root.render(<WorkGalleryCard artifact={artifact} onSelect={vi.fn()} />));
    expect(video).toBeUndefined();
    await act(async () => {
      for (const callback of callbacks)
        callback([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver);
    });
    if (!video) throw new Error('Visible card did not admit its reader');
    expect(video.preload).toBe('metadata');
    expect(video.muted).toBe(true);
    expect(video.autoplay).toBe(false);
    const cancelled = video;
    await act(async () => {
      for (const callback of callbacks)
        callback([{ isIntersecting: false } as IntersectionObserverEntry], {} as IntersectionObserver);
    });
    expect(cancelled.getAttribute('src')).toBeNull();
    expect(unload).toHaveBeenCalledTimes(1);
    await act(async () => cancelled.dispatchEvent(new Event('seeked')));
    expect(host.querySelector('canvas')).toBeNull();
    await act(async () => {
      for (const callback of callbacks)
        callback([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver);
    });
    expect(video).not.toBe(cancelled);
    Object.defineProperties(video, {
      duration: { value: 10 },
      readyState: { value: 2 },
      videoWidth: { value: 640 },
      videoHeight: { value: 360 },
    });
    await act(async () => video?.dispatchEvent(new Event('loadedmetadata')));
    expect(video.currentTime).toBe(3);
    await act(async () => video?.dispatchEvent(new Event('seeked')));
    expect(host.textContent).toContain('0:10');
    expect(host.querySelector('canvas')).not.toBeNull();
    expect(video.getAttribute('src')).toBeNull();
    expect(unload).toHaveBeenCalledTimes(2);
    await act(async () => {
      for (const callback of callbacks)
        callback([{ isIntersecting: false } as IntersectionObserverEntry], {} as IntersectionObserver);
    });
    expect(host.querySelector('canvas')).not.toBeNull();
  } finally {
    await act(async () => root.unmount());
  }
});
