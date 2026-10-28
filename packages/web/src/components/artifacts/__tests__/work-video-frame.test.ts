import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { requestWorkVideoFrame } from '../work-video-frame';

let videos: HTMLVideoElement[];
let cancel: Array<() => void>;
const load = vi.fn();
beforeEach(() => {
  videos = [];
  cancel = [];
  const create = document.createElement.bind(document);
  vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
    const node = create(tag);
    if (node instanceof HTMLVideoElement) videos.push(node);
    return node;
  });
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(load);
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    drawImage: vi.fn(),
  } as unknown as CanvasRenderingContext2D);
});
afterEach(() => {
  for (const stop of cancel) stop();
  vi.useRealTimers();
  vi.restoreAllMocks();
  load.mockClear();
});
function add(url: string, receive = vi.fn()) {
  cancel.push(requestWorkVideoFrame(url, receive));
  return receive;
}
function reader(index: number) {
  const value = videos[index];
  if (!value) throw new Error('Expected video reader');
  return value;
}
function stop(index: number) {
  const value = cancel[index];
  if (!value) throw new Error('Expected queued card');
  value();
}
function frame(video: HTMLVideoElement) {
  Object.defineProperties(video, {
    duration: { value: 10, configurable: true },
    readyState: { value: 2, configurable: true },
    videoWidth: { value: 1280, configurable: true },
    videoHeight: { value: 720, configurable: true },
  });
  video.dispatchEvent(new Event('loadedmetadata'));
  expect(video.currentTime).toBe(3);
  video.dispatchEvent(new Event('seeked'));
}
it('limits all card readers to two and unloads a decoded video before admitting the next', () => {
  const first = add('/one.mp4');
  add('/two.mp4');
  add('/three.mp4');
  expect(videos).toHaveLength(2);
  frame(reader(0));
  expect(first).toHaveBeenCalledWith(expect.objectContaining({ duration: 10, canvas: expect.any(HTMLCanvasElement) }));
  expect(reader(0).getAttribute('src')).toBeNull();
  expect(load).toHaveBeenCalledTimes(1);
  expect(videos).toHaveLength(3);
});
it('cancels queued and active offscreen cards without delivering a late frame', () => {
  const first = add('/one.mp4');
  add('/two.mp4');
  const third = add('/three.mp4');
  stop(2);
  stop(0);
  expect(videos).toHaveLength(2);
  expect(reader(0).getAttribute('src')).toBeNull();
  reader(0).dispatchEvent(new Event('loadedmetadata'));
  reader(0).dispatchEvent(new Event('seeked'));
  expect(first).not.toHaveBeenCalled();
  expect(third).not.toHaveBeenCalled();
});
it('an unreadable or stalled video releases its slot so other cards can obtain frames', () => {
  vi.useFakeTimers();
  const first = add('/stalled.mp4');
  const second = add('/broken.mp4');
  const third = add('/good.mp4');
  reader(1).dispatchEvent(new Event('error'));
  expect(second).toHaveBeenCalledWith(null);
  expect(videos).toHaveLength(3);
  frame(reader(2));
  expect(third).toHaveBeenCalledWith(expect.objectContaining({ duration: 10 }));
  vi.advanceTimersByTime(6000);
  expect(first).toHaveBeenCalledWith(null);
  expect(videos.every((video) => !video.hasAttribute('src'))).toBe(true);
});
it('captures a completed seek when the browser rounds a short clip time down to microseconds', () => {
  const receive = add('/short.mp4');
  const video = reader(0);
  Object.defineProperties(video, {
    duration: { value: 11.333333 },
    readyState: { value: 4 },
    videoWidth: { value: 640 },
    videoHeight: { value: 360 },
  });
  video.dispatchEvent(new Event('loadedmetadata'));
  const target = video.currentTime;
  Object.defineProperty(video, 'currentTime', { value: Math.floor(target * 1e6) / 1e6 });
  expect(video.currentTime).toBeLessThan(target);
  video.dispatchEvent(new Event('loadeddata'));
  expect(receive).not.toHaveBeenCalled();
  video.dispatchEvent(new Event('seeked'));
  expect(receive).toHaveBeenCalledWith(expect.objectContaining({ duration: 11.333333 }));
  expect(video.getAttribute('src')).toBeNull();
});
it('continues serving other cards even if a consumer callback throws', () => {
  add(
    '/one.mp4',
    vi.fn(() => {
      throw new Error('consumer failed');
    }),
  );
  add('/two.mp4');
  add('/three.mp4');
  expect(() => reader(0).onerror?.(new Event('error'))).toThrow('consumer failed');
  expect(videos).toHaveLength(3);
});
