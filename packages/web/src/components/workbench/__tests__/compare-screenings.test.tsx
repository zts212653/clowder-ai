import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { VideoProjectScreeningCompare } from '../video-project/compare-screenings';
import { comparisonShot, comparisonSide } from './compare-screening.fixture';

let root: Root, container: HTMLDivElement;
const onRightFrame = vi.fn();
const callbacks = new Map<HTMLVideoElement, VideoFrameRequestCallback>();
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(function (this: HTMLMediaElement) {
    Object.defineProperty(this, 'paused', { configurable: true, value: true });
  });
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(function (this: HTMLMediaElement) {
    Object.defineProperty(this, 'paused', { configurable: true, value: false });
    return Promise.resolve();
  });
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    callback(0);
    return 0;
  });
  Object.defineProperty(HTMLVideoElement.prototype, 'requestVideoFrameCallback', {
    configurable: true,
    value: function (this: HTMLVideoElement, callback: VideoFrameRequestCallback) {
      callbacks.set(this, callback);
      return 1;
    },
  });
  Object.defineProperty(HTMLVideoElement.prototype, 'cancelVideoFrameCallback', { configurable: true, value: vi.fn() });
  onRightFrame.mockClear();
  callbacks.clear();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete (HTMLVideoElement.prototype as Partial<HTMLVideoElement>).requestVideoFrameCallback;
  delete (HTMLVideoElement.prototype as Partial<HTMLVideoElement>).cancelVideoFrameCallback;
});
const left = () => comparisonSide('old', [comparisonShot('shot-1', 0, 100), comparisonShot('shot-2', 100, 100)]);
const right = () => comparisonSide('new', [comparisonShot('shot-1', 0, 50), comparisonShot('shot-2', 50, 100)], 50);
async function render(old = left(), next = right()) {
  await act(async () =>
    root.render(<VideoProjectScreeningCompare left={old} right={next} onRightFrame={onRightFrame} />),
  );
  const videos = Array.from(container.querySelectorAll('video'));
  await act(async () =>
    videos.forEach((video) => {
      Object.defineProperty(video, 'readyState', { configurable: true, value: 1 });
      video.dispatchEvent(new Event('loadedmetadata'));
    }),
  );
  return videos;
}
function change(element: HTMLInputElement | HTMLSelectElement, value: string) {
  act(() => {
    const prototype = element instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLSelectElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
  });
}
function requiredElement<T extends Element>(selector: string): T {
  const element = container.querySelector<T>(selector);
  if (!element) throw new Error(`Missing comparison element: ${selector}`);
  return element;
}
function playButton() {
  return container.querySelector<HTMLButtonElement>('button');
}

it('always drives from the right selected version and seeks a resized stable shot', async () => {
  const videos = await render();
  change(requiredElement<HTMLInputElement>('input'), '2.5');
  expect(videos.map((video) => video.currentTime)).toEqual([5, 2.5]);
  act(() => {
    videos[1].currentTime = 10;
    videos[1].dispatchEvent(new Event('timeupdate'));
  });
  expect(videos[0].currentTime).toBe(15);
});
it('keeps the right as leader even when its complete stream is shorter', async () => {
  const videos = await render(left(), comparisonSide('new', [comparisonShot('shot-1', 0, 50)]));
  expect(container.querySelector('input')?.max).toBe('5');
  act(() => {
    videos[1].currentTime = 2.5;
    videos[1].dispatchEvent(new Event('timeupdate'));
  });
  expect(videos[0].currentTime).toBe(5);
  expect(container.querySelector('output')?.textContent).toContain('0:02 / 0:05');
});
it('synchronizes the effective rate and freezes only the missing mapped side', async () => {
  const videos = await render();
  change(requiredElement<HTMLInputElement>('input'), '2.5');
  change(requiredElement<HTMLSelectElement>('select'), '1.5');
  expect(videos.map((video) => video.playbackRate)).toEqual([3, 1.5]);
  await act(async () => playButton()?.click());
  expect(videos.map((video) => video.paused)).toEqual([false, false]);
  act(() => {
    videos[1].currentTime = 17;
    videos[1].dispatchEvent(new Event('timeupdate'));
  });
  expect(videos.map((video) => video.paused)).toEqual([true, false]);
  expect(container.textContent).toContain('右侧可以继续播放');
  expect(videos[0].hidden).toBe(true);
  change(requiredElement<HTMLInputElement>('input'), '2.5');
  expect(videos.map((video) => video.paused)).toEqual([false, false]);
  expect(videos[0].hidden).toBe(false);
  await act(async () => playButton()?.click());
  expect(videos.map((video) => video.paused)).toEqual([true, true]);
});
it('stops the pair on right ended and does not promote a left-ended signal to the driver', async () => {
  const videos = await render();
  await act(async () => playButton()?.click());
  act(() => videos[0].dispatchEvent(new Event('ended')));
  expect(playButton()?.textContent).toBe('暂停两版');
  act(() => videos[1].dispatchEvent(new Event('ended')));
  expect(playButton()?.textContent).toBe('同步播放');
  expect(videos.map((video) => video.paused)).toEqual([true, true]);
});
it('exposes only a confirmed right decoded frame and rejects late previous-pair frames', async () => {
  const videos = await render();
  act(() => callbacks.get(videos[1])?.(0, { mediaTime: 0 } as VideoFrameCallbackMetadata));
  expect(onRightFrame).toHaveBeenLastCalledWith(0);
  change(requiredElement<HTMLInputElement>('input'), '2.5');
  expect(onRightFrame).toHaveBeenLastCalledWith(null);
  act(() => {
    videos[1].dispatchEvent(new Event('seeked'));
    callbacks.get(videos[1])?.(0, { mediaTime: 2.5 } as VideoFrameCallbackMetadata);
  });
  expect(onRightFrame).toHaveBeenLastCalledWith(2.5);
  const late = callbacks.get(videos[1]);
  const next = right();
  next.screening = { ...next.screening, id: 'newer' };
  next.mediaUrl = `${next.mediaUrl}?newer`;
  await render(left(), next);
  act(() => late?.(0, { mediaTime: 10 } as VideoFrameCallbackMetadata));
  expect(onRightFrame).toHaveBeenLastCalledWith(null);
  expect(container.querySelector('figure[aria-label="新版（意见版本）"] video')?.getAttribute('src')).toContain(
    '?newer',
  );
});
it('revokes the previous decoded frame immediately when replay seeks from the end', async () => {
  const videos = await render();
  act(() => {
    videos[1].currentTime = 20;
    callbacks.get(videos[1])?.(0, { mediaTime: 19.9 } as VideoFrameCallbackMetadata);
    videos[1].dispatchEvent(new Event('ended'));
  });
  expect(onRightFrame).toHaveBeenLastCalledWith(19.9);
  await act(async () => playButton()?.click());
  expect(videos[1].currentTime).toBe(0);
  expect(onRightFrame).toHaveBeenLastCalledWith(null);
});
