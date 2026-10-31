import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MediaVersionCompare } from '../media-compare/MediaVersionCompare';
import { compareAsset } from './media-compare.fixture';

const mocks = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock('@/utils/api-client', () => ({ apiFetch: (...args: unknown[]) => mocks.apiFetch(...args) }));
let root: Root, container: HTMLDivElement, resize: ResizeObserverCallback;
let urls: number;
const unavailable = vi.fn();
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(callback: ResizeObserverCallback) {
        resize = callback;
      }
      observe() {}
      disconnect() {}
    },
  );
  urls = 0;
  vi.stubGlobal(
    'URL',
    class extends URL {
      static createObjectURL = vi.fn(() => `blob:media-${++urls}`);
      static revokeObjectURL = vi.fn();
    },
  );
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
  mocks.apiFetch.mockReset().mockImplementation(async () => new Response(new Blob(['media'])));
  unavailable.mockReset();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
async function render(kind: 'image' | 'video' = 'image', width = 390, candidateRevision = 2) {
  await act(async () =>
    root.render(
      <MediaVersionCompare
        original={{ asset: compareAsset(1, kind, width), label: '原版' }}
        candidate={{ asset: compareAsset(candidateRevision, kind, width), label: '候选版本' }}
        onUnavailable={unavailable}
      />,
    ),
  );
}
function setWidth(width: number, height = 0) {
  act(() => resize([{ contentRect: { width, height } } as ResizeObserverEntry], {} as ResizeObserver));
}
function click(label: string) {
  act(() =>
    Array.from(container.querySelectorAll('button'))
      .find((button) => button.textContent === label)
      ?.click(),
  );
}

it('reads both exact PNG revisions, chooses narrow side-by-side and switches without mutations or losing scroll', async () => {
  await render();
  setWidth(1000);
  expect(container.querySelector('section')?.getAttribute('data-compare-mode')).toBe('side');
  expect(mocks.apiFetch.mock.calls.map(([path]) => path)).toEqual([
    '/api/content-publications/published-pair/media/1',
    '/api/content-publications/published-pair/media/2',
  ]);
  const viewport = container.querySelector<HTMLElement>('[data-testid="media-compare-viewport"]')!;
  viewport.scrollTop = 480;
  click('切换');
  click('原版 · v1');
  click('候选版本 · v2');
  expect(viewport.scrollTop).toBe(480);
  expect(mocks.apiFetch).toHaveBeenCalledTimes(2);
  expect(container.querySelector('figure[aria-label="原版"]')?.hasAttribute('hidden')).toBe(true);
  setWidth(390);
  expect(container.querySelector('section')?.getAttribute('data-compare-mode')).toBe('toggle');
});

it('uses toggle for wide media and hides old bytes immediately when the exact candidate changes', async () => {
  await render('image', 4096);
  setWidth(1000);
  expect(container.querySelector('section')?.getAttribute('data-compare-mode')).toBe('toggle');
  const pending: ((response: Response) => void)[] = [];
  mocks.apiFetch.mockImplementation(() => new Promise<Response>((resolve) => pending.push(resolve)));
  await render('image', 4096, 3);
  expect(container.querySelectorAll('img')).toHaveLength(0);
  await act(async () => {
    pending.forEach((resolve) => resolve(new Response(new Blob(['new']))));
  });
  expect(container.textContent).toContain('v3');
  expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:media-1');
});

it.each([403, 410])('closes the whole pair on %s and reports the existing owner access boundary', async (status) => {
  mocks.apiFetch.mockImplementation(
    async (path: string) => new Response(new Blob(['media']), { status: path.endsWith('/2') ? status : 200 }),
  );
  await render();
  expect(container.querySelectorAll('img')).toHaveLength(0);
  expect(container.textContent).toContain('此版本当前不可访问');
  expect(unavailable).toHaveBeenCalledOnce();
});

it('ignores a late old read after cancellation/unmount', async () => {
  const pending: ((response: Response) => void)[] = [];
  mocks.apiFetch.mockImplementation(() => new Promise<Response>((resolve) => pending.push(resolve)));
  await render();
  await act(async () => root.render(<p>已返回</p>));
  await act(async () => {
    pending.forEach((resolve) => resolve(new Response(new Blob(['late']))));
  });
  expect(container.textContent).toBe('已返回');
  expect(URL.createObjectURL).not.toHaveBeenCalled();
});

it('aligns MP4 by actual per-version starts, preserves playhead on version switch and freezes the shorter tail', async () => {
  await render('video');
  setWidth(1000);
  const videos = Array.from(container.querySelectorAll('video'));
  await act(async () => {
    videos.forEach((video) => {
      Object.defineProperty(video, 'readyState', { value: 1 });
      video.dispatchEvent(new Event('loadedmetadata'));
    });
  });
  expect(videos.map((video) => video.currentTime)).toEqual([1, 2]);
  const slider = container.querySelector<HTMLInputElement>('input[type="range"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(slider, '3');
    slider.dispatchEvent(new Event('change', { bubbles: true }));
    slider.dispatchEvent(new Event('input', { bubbles: true }));
  });
  expect(videos.map((video) => video.currentTime)).toEqual([3, 5]);
  click('切换');
  click('原版 · v1');
  expect(videos.map((video) => video.currentTime)).toEqual([3, 5]);
  await act(async () => {
    click('同步播放');
  });
  expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(1);
  click('暂停两版');
  expect(container.textContent).toContain('较短版本到末尾后停留');
});

it('keeps portrait PNG readable by fitting width and scrolling the tall media', async () => {
  await render();
  setWidth(1000, 500);
  const original = container.querySelector<HTMLDivElement>('figure[aria-label="原版"] > div');
  expect(original?.style.width).toBe('390px');
  setWidth(390, 300);
  const candidate = container.querySelector<HTMLDivElement>('figure[aria-label="候选版本"] > div');
  expect(candidate?.style.width).toBe('390px');
});

it('resumes the shorter video when scrubbing back from its ended tail during synchronized playback', async () => {
  vi.mocked(HTMLMediaElement.prototype.play).mockImplementation(function (this: HTMLMediaElement) {
    Object.defineProperty(this, 'paused', { value: false, configurable: true });
    return Promise.resolve();
  });
  await render('video');
  const videos = Array.from(container.querySelectorAll('video'));
  await act(async () => {
    videos.forEach((video) => {
      Object.defineProperty(video, 'readyState', { value: 1 });
      video.dispatchEvent(new Event('loadedmetadata'));
    });
  });
  await act(async () => click('同步播放'));
  expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(2);
  act(() => {
    videos[0].currentTime = 3;
    Object.defineProperty(videos[0], 'paused', { value: true, configurable: true });
    videos[0].dispatchEvent(new Event('ended'));
  });
  const slider = container.querySelector<HTMLInputElement>('input[type="range"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(slider, '0.4');
    slider.dispatchEvent(new Event('input', { bubbles: true }));
  });
  expect(videos.map((video) => video.currentTime)).toEqual([1.4, 2.4]);
  expect(videos[0].paused).toBe(false);
  expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(3);
});

it('does not auto-replay an ended shorter video whose declared duration exceeds its decoded end', async () => {
  vi.mocked(HTMLMediaElement.prototype.play).mockImplementation(function (this: HTMLMediaElement) {
    Object.defineProperty(this, 'paused', { value: false, configurable: true });
    return Promise.resolve();
  });
  await render('video');
  const videos = Array.from(container.querySelectorAll('video'));
  await act(async () =>
    videos.forEach((video) => {
      Object.defineProperty(video, 'readyState', { value: 1 });
      video.dispatchEvent(new Event('loadedmetadata'));
    }),
  );
  await act(async () => click('同步播放'));
  Object.defineProperties(videos[0], {
    ended: { value: true },
    paused: { value: true, configurable: true },
  });
  videos[0].currentTime = 2.52;
  act(() => {
    videos[0].dispatchEvent(new Event('ended'));
    videos[1].currentTime = 3.55;
    videos[1].dispatchEvent(new Event('timeupdate'));
  });
  expect(videos[0].paused).toBe(true);
  expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(2);
});
