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

it('keeps a registered cut poster in place while reading duration without seeking', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
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
    const video = host.querySelector('video');
    if (!video) throw new Error('Video preview missing');
    expect(video.getAttribute('poster')).toBe(demo.poster);
    Object.defineProperty(video, 'duration', { value: 48.5 });
    await act(async () => video.dispatchEvent(new Event('loadedmetadata')));
    expect(video.currentTime).toBe(0);
    expect(host.textContent).toContain('0:48');
    await act(async () => video.dispatchEvent(new Event('error')));
    expect(host.querySelector('.work-cover-poster')?.getAttribute('src')).toBe(demo.poster);
  } finally {
    await act(async () => root.unmount());
  }
});

it('requests video only near the viewport, seeks beyond the opening, and retains a readable failure cover', async () => {
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
    expect(host.querySelector('video')).toBeNull();
    await act(async () => {
      for (const callback of callbacks)
        callback([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver);
    });
    const video = host.querySelector('video')!;
    expect(video).not.toBeNull();
    expect(video.preload).toBe('metadata');
    expect(video.muted).toBe(true);
    expect(video.autoplay).toBe(false);
    Object.defineProperty(video, 'duration', { value: 10, configurable: true });
    await act(async () => video.dispatchEvent(new Event('loadedmetadata')));
    expect(video.currentTime).toBe(3);
    await act(async () => video.dispatchEvent(new Event('seeked')));
    expect(host.textContent).toContain('0:10');
    await act(async () => video.dispatchEvent(new Event('error')));
    expect(host.textContent).toContain('视频');
    expect(host.textContent).not.toContain('0:10');
  } finally {
    await act(async () => root.unmount());
  }
});
