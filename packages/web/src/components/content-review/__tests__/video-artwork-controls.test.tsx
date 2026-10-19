import type { ImmutableMedia } from '@cat-cafe/shared';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { writeShellLanguage } from '@/components/shell/shell-language';
import { WorkspaceReviewMediaElement } from '@/components/workbench/content-review/WorkspaceReviewMediaElement';
import { ArtworkVideoPlayback } from '../ArtworkVideoPlayback';
import { VideoArtworkControls } from '../VideoArtworkControls';

const media: Extract<ImmutableMedia, { kind: 'video' }> = {
  kind: 'video',
  width: 1280,
  height: 720,
  codedWidth: 1280,
  codedHeight: 720,
  rotation: 0,
  pixelAspectRatio: { numerator: 1, denominator: 1 },
  streamIndex: 0,
  containerStartSeconds: 0,
  streamId: 'original-stream',
  timebase: { numerator: 1, denominator: 15360 },
  startTick: 0,
  durationTicks: 5197824,
};
let root: Root, container: HTMLDivElement, video: HTMLVideoElement;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  video = document.createElement('video');
  writeShellLanguage('zh');
  vi.spyOn(video, 'pause').mockImplementation(() => {});
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  writeShellLanguage('zh');
});
it.each([
  { property: 'volume', label: '视频音量', first: 0, second: 0.05, external: 0.35, event: 'volumechange' },
  { property: 'playbackRate', label: '播放速度', first: 1.5, second: 0.5, external: 2, event: 'ratechange' },
] as const)('keeps $property input visible before a delayed native media event', async (spec) => {
  // jsdom emits these native events synchronously. Model the observed browser's
  // deferred event so another user input can arrive before the native callback.
  Object.defineProperty(video, spec.property, { value: 1, writable: true, configurable: true });
  await act(async () =>
    root.render(<ArtworkVideoPlayback video={{ current: video }} seconds={0} duration={60} paused seekTo={vi.fn()} />),
  );
  const control = container.querySelector<HTMLInputElement | HTMLSelectElement>(`[aria-label="${spec.label}"]`);
  expect(control).toBeTruthy();
  const choose = (value: number) =>
    act(() => {
      if (control instanceof HTMLInputElement) {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(control, String(value));
        control.dispatchEvent(new Event('input', { bubbles: true }));
      } else if (control) {
        control.value = String(value);
        control.dispatchEvent(new Event('change', { bubbles: true }));
      }
    });
  choose(spec.first);
  expect(video[spec.property]).toBe(spec.first);
  expect(control?.value).toBe(String(spec.first));
  choose(spec.second);
  expect(video[spec.property]).toBe(spec.second);
  expect(control?.value).toBe(String(spec.second));
  act(() => {
    video[spec.property] = spec.external;
    video.dispatchEvent(new Event(spec.event));
  });
  expect(control?.value).toBe(String(spec.external));
});
it('has one custom seek control, keeps native controls for other viewers and translates every tool including range entry', async () => {
  const seekTo = vi.fn();
  const props = {
    media,
    video: { current: video },
    seconds: 82,
    frameReady: true,
    mode: 'view' as const,
    canAnnotate: true,
    onModeChange: vi.fn(),
    onRange: vi.fn(),
    onFrame: vi.fn(),
    seekTo,
    annotations: [],
    onAnnotationActive: vi.fn(),
    children: null,
  };
  await act(async () =>
    root.render(
      <>
        <WorkspaceReviewMediaElement
          src="blob:original"
          error={null}
          media={media}
          video={props.video}
          customControls
          selectionActive={false}
          onSeeking={() => {}}
          onSeeked={() => {}}
          onSeconds={() => {}}
          onError={() => {}}
        />
        <VideoArtworkControls {...props} />
      </>,
    ),
  );
  expect(container.querySelector('video')?.controls).toBe(false);
  expect(container.querySelectorAll('input[aria-label="视频播放位置"]')).toHaveLength(1);
  await act(async () => writeShellLanguage('en'));
  expect(container.textContent).not.toMatch(/选时间段|圈这一帧|画笔|播放|视频/);
  const range = [...container.querySelectorAll('button')].find((button) => button.textContent === 'Select time range');
  await act(async () => range?.click());
  expect(container.querySelector('[aria-label="Range start"]')).toBeTruthy();
  expect(container.querySelector('[aria-label="Range end"]')).toBeTruthy();
  expect(container.textContent).toContain('Add to Chat');
  const rate = container.querySelector<HTMLSelectElement>('[aria-label="Playback speed"]');
  await act(async () => {
    if (rate) {
      rate.value = '1.5';
      rate.dispatchEvent(new Event('change', { bubbles: true }));
    }
  });
  expect(container.querySelector('video')?.playbackRate).toBe(1.5);
  await act(async () =>
    root.render(
      <WorkspaceReviewMediaElement
        src="blob:original"
        error={null}
        media={media}
        video={props.video}
        selectionActive={false}
        onSeeking={() => {}}
        onSeeked={() => {}}
        onSeconds={() => {}}
        onError={() => {}}
      />,
    ),
  );
  expect(container.querySelector('video')?.controls).toBe(true);
});
it('keeps circle disabled until an actually presented paused frame is ready and returns a selected range in original ticks', async () => {
  const onRange = vi.fn(),
    onFrame = vi.fn();
  const props = {
    media,
    video: { current: video },
    seconds: 82,
    mode: 'view' as const,
    canAnnotate: true,
    onModeChange: vi.fn(),
    onRange,
    onFrame,
    seekTo: vi.fn(),
    annotations: [],
    onAnnotationActive: vi.fn(),
    children: null,
  };
  await act(async () => root.render(<VideoArtworkControls {...props} frameReady={false} />));
  const buttons = () => [...container.querySelectorAll('button')];
  expect(buttons().find((b) => b.textContent === '圈这一帧')?.disabled).toBe(true);
  expect(container.textContent).toContain('画面还没停稳');
  await act(async () => root.render(<VideoArtworkControls {...props} frameReady />));
  expect(buttons().find((b) => b.textContent === '圈这一帧')?.disabled).toBe(false);
  await act(async () =>
    buttons()
      .find((b) => b.textContent === '选时间段')
      ?.click(),
  );
  expect(onRange).not.toHaveBeenCalled();
  await act(async () =>
    container.querySelector('form')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
  );
  expect(onRange).toHaveBeenCalledExactlyOnceWith({
    kind: 'video-range',
    streamId: 'original-stream',
    startTick: 1259520,
    endTick: 5197824,
  });
  expect(onFrame).not.toHaveBeenCalled();
});
