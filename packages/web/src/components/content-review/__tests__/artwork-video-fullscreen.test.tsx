import type { ImmutableMedia } from '@cat-cafe/shared';
import { act, createRef } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { writeShellLanguage } from '@/components/shell/shell-language';
import { VideoArtworkControls } from '../VideoArtworkControls';

const media: Extract<ImmutableMedia, { kind: 'video' }> = {
  kind: 'video',
  width: 640,
  height: 360,
  codedWidth: 640,
  codedHeight: 360,
  rotation: 0,
  pixelAspectRatio: { numerator: 1, denominator: 1 },
  streamId: 'original',
  streamIndex: 0,
  timebase: { numerator: 1, denominator: 1000 },
  startTick: 0,
  durationTicks: 60000,
  containerStartSeconds: 0,
};
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let currentFullscreen: Element | null;
const player = createRef<HTMLDivElement>();
const video = createRef<HTMLVideoElement>();
const enter = vi.fn(async () => {
  currentFullscreen = player.current;
  document.dispatchEvent(new Event('fullscreenchange'));
});
const exit = vi.fn(async () => {
  currentFullscreen = null;
  document.dispatchEvent(new Event('fullscreenchange'));
});
beforeEach(async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  currentFullscreen = null;
  enter.mockClear();
  exit.mockClear();
  Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => currentFullscreen });
  Object.defineProperty(document, 'exitFullscreen', { configurable: true, value: exit });
  Object.defineProperty(HTMLElement.prototype, 'requestFullscreen', { configurable: true, value: enter });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  writeShellLanguage('zh');
  await act(async () =>
    root.render(
      <div ref={player} data-artwork-video-player>
        <video ref={video} />
        <VideoArtworkControls
          media={media}
          video={video}
          player={player}
          seconds={12.5}
          frameReady
          mode="view"
          canAnnotate
          onModeChange={vi.fn()}
          onRange={vi.fn()}
          onFrame={vi.fn()}
          seekTo={vi.fn()}
          annotations={[
            { id: 'range', anchor: { kind: 'video-range', streamId: 'original', startTick: 10000, endTick: 20000 } },
          ]}
          pendingMarks={[
            {
              id: 'pending-range',
              label: '2',
              anchor: { kind: 'video-range', streamId: 'original', startTick: 30000, endTick: 45000 },
            },
          ]}
          onAnnotationActive={vi.fn()}
        >
          {null}
        </VideoArtworkControls>
      </div>,
    ),
  );
  Object.defineProperty(player.current, 'getClientRects', { value: () => [{ width: 640, height: 360 }] });
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  delete (HTMLElement.prototype as Partial<HTMLElement>).requestFullscreen;
  delete (document as Partial<Document>).exitFullscreen;
  delete (document as { fullscreenElement?: Element | null }).fullscreenElement;
});
it('requests fullscreen for the original player and preserves the video, time and selected range on browser exit', async () => {
  const original = video.current;
  if (original) original.currentTime = 12.5;
  const button = container.querySelector<HTMLButtonElement>('[aria-label="全屏播放"]');
  expect(button).toBeTruthy();
  await act(async () => button?.click());
  expect(enter.mock.contexts).toEqual([player.current]);
  expect(container.querySelector('[aria-label="退出全屏"]')).toBeTruthy();
  expect(container.querySelector('[aria-label="视频批注工具"]')).toBeNull();
  expect(container.querySelector('[aria-label="查看批注 1"]')).toBeTruthy();
  const pending = container.querySelector<HTMLElement>('[data-video-range="pending-range"]');
  expect(pending).toBeTruthy();
  expect(pending?.style.left).toBe('50%');
  expect(pending?.style.width).toBe('25%');
  await act(async () => {
    currentFullscreen = null;
    document.dispatchEvent(new Event('fullscreenchange'));
  });
  expect(video.current).toBe(original);
  expect(video.current?.currentTime).toBe(12.5);
  expect(container.querySelector('[aria-label="视频批注工具"]')).toBeTruthy();
});
it('exits on an Escape delivered by the browser without closing the surrounding artwork host', async () => {
  const original = video.current;
  const hostKey = vi.fn();
  document.addEventListener('keydown', hostKey);
  try {
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="全屏播放"]')?.click());
    await act(async () =>
      player.current?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })),
    );
    expect(exit).toHaveBeenCalledOnce();
    expect(currentFullscreen).toBeNull();
    expect(hostKey).not.toHaveBeenCalled();
    expect(video.current).toBe(original);
  } finally {
    document.removeEventListener('keydown', hostKey);
  }
});
it('uses F and picture double click, while preserving text entry and ignoring modified shortcut keys', async () => {
  const input = document.createElement('textarea');
  player.current?.append(input);
  input.focus();
  await act(async () => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', bubbles: true })));
  expect(enter).not.toHaveBeenCalled();
  player.current?.setAttribute('tabindex', '0');
  player.current?.focus();
  await act(async () =>
    player.current?.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, bubbles: true })),
  );
  expect(enter).not.toHaveBeenCalled();
  await act(async () => player.current?.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', bubbles: true })));
  expect(enter).toHaveBeenCalledTimes(1);
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="退出全屏"]')?.click());
  expect(exit).toHaveBeenCalledTimes(1);
  await act(async () => video.current?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })));
  expect(enter).toHaveBeenCalledTimes(2);
});
it('keeps the ordinary tools usable after a rejected fullscreen request', async () => {
  enter.mockRejectedValueOnce(new Error('Fullscreen permission denied'));
  const button = container.querySelector<HTMLButtonElement>('[aria-label="全屏播放"]');
  expect(button).toBeTruthy();
  await act(async () => button?.click());
  expect(container.querySelector('[aria-label="视频批注工具"]')).toBeTruthy();
  expect(container.querySelector('[aria-label="退出全屏"]')).toBeNull();
  expect(container.querySelector('[role="status"]')?.textContent).toContain('全屏');
});
