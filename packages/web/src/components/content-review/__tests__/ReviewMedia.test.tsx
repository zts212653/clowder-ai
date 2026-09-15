import type { ArtifactReviewAnnotation, ReviewedMediaAsset } from '@cat-cafe/shared';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ReviewCanvasMode } from '../ReviewCanvasToolbar';
import { ReviewMedia } from '../ReviewMedia';

vi.mock('../useReviewMediaSource', () => ({
  useReviewMediaSource: () => ({ src: 'blob:retained-video', error: null, setError: vi.fn() }),
}));
const asset: ReviewedMediaAsset = {
  contentRef: 'media',
  ownerRevision: 1,
  blobDigest: `sha256:${'a'.repeat(64)}`,
  mediaType: 'video/mp4',
  ownerReceiptRef: 'receipt:media',
  sourcePublication: { artifactRef: '/uploads/video.mp4', sourceRef: 'message:thread:video', revision: '1' },
  media: {
    kind: 'video',
    width: 360,
    height: 640,
    codedWidth: 640,
    codedHeight: 360,
    rotation: 90,
    pixelAspectRatio: { numerator: 1, denominator: 1 },
    streamId: '0:0x1',
    streamIndex: 0,
    timebase: { numerator: 1, denominator: 12800 },
    startTick: 25600,
    durationTicks: 37376,
    containerStartSeconds: 2,
  },
};
const annotation: ArtifactReviewAnnotation = {
  id: 'mark',
  author: { kind: 'human', actorId: 'operator' },
  body: '这帧',
  state: 'open',
  replies: [],
  anchor: {
    kind: 'video-range',
    streamId: '0:0x1',
    startTick: 25600,
    endTick: 62976,
    frameRegion: { tick: 27136, x: 90, y: 192, width: 144, height: 192 },
  },
  createdAt: '2026-09-07T16:00:00Z',
  updatedAt: '2026-09-07T16:00:00Z',
};
let root: ReturnType<typeof createRoot>, container: HTMLDivElement;
let video: HTMLVideoElement, playhead: number, seeking: boolean;
let callbacks: Map<number, VideoFrameRequestCallback>, callbackId: number;
let focusRequest: { annotationId: string } | null;
let frameDescriptor: PropertyDescriptor | undefined, cancelDescriptor: PropertyDescriptor | undefined;
const assigned = vi.fn(),
  onActive = vi.fn(),
  onSelect = vi.fn();
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  callbacks = new Map();
  callbackId = 0;
  playhead = 2;
  seeking = false;
  focusRequest = null;
  assigned.mockClear();
  onActive.mockClear();
  onSelect.mockClear();
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
  frameDescriptor = Object.getOwnPropertyDescriptor(HTMLVideoElement.prototype, 'requestVideoFrameCallback');
  cancelDescriptor = Object.getOwnPropertyDescriptor(HTMLVideoElement.prototype, 'cancelVideoFrameCallback');
  Object.defineProperty(HTMLVideoElement.prototype, 'requestVideoFrameCallback', {
    configurable: true,
    value(callback: VideoFrameRequestCallback) {
      callbacks.set(++callbackId, callback);
      return callbackId;
    },
  });
  Object.defineProperty(HTMLVideoElement.prototype, 'cancelVideoFrameCallback', {
    configurable: true,
    value(id: number) {
      callbacks.delete(id);
    },
  });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  for (const [key, descriptor] of [
    ['requestVideoFrameCallback', frameDescriptor],
    ['cancelVideoFrameCallback', cancelDescriptor],
  ] as const) {
    if (descriptor) Object.defineProperty(HTMLVideoElement.prototype, key, descriptor);
    else Reflect.deleteProperty(HTMLVideoElement.prototype, key);
  }
});
async function render(
  activeId: string | null = null,
  fresh = false,
  {
    mode = 'view',
    canAnnotate = true,
    selectionKey = 'annotation:one',
  }: { mode?: ReviewCanvasMode; canAnnotate?: boolean; selectionKey?: string } = {},
) {
  if (activeId !== (focusRequest?.annotationId ?? null)) focusRequest = activeId ? { annotationId: activeId } : null;
  await act(async () =>
    root.render(
      createElement(ReviewMedia, {
        reviewId: 'review',
        round: 1,
        asset: fresh ? structuredClone(asset) : asset,
        annotations: [fresh ? structuredClone(annotation) : annotation],
        selected: null,
        focusRequest,
        canAnnotate,
        onSelect,
        onActive,
        mode,
        selectionKey,
        onUnavailable: vi.fn(),
      }),
    ),
  );
  if (!video || video !== container.querySelector('video')) {
    video = container.querySelector('video')!;
    Object.defineProperties(video, {
      currentTime: {
        configurable: true,
        get: () => playhead,
        set: (value: number) => {
          assigned(value);
          playhead = value;
          seeking = true;
        },
      },
      seeking: { configurable: true, get: () => seeking },
      readyState: { configurable: true, get: () => (seeking ? 1 : 4) },
    });
  }
}
const button = () => [...container.querySelectorAll('button')].find((item) => item.textContent === '圈出这帧画面')!;
async function present(mediaTime: number) {
  const [id, callback] = [...callbacks.entries()][0];
  callbacks.delete(id);
  await act(async () =>
    callback(0, {
      mediaTime,
      presentedFrames: id,
      width: 360,
      height: 640,
      presentationTime: 0,
      expectedDisplayTime: 0,
    }),
  );
}
async function event(type: 'seeking' | 'seeked') {
  seeking = type === 'seeking';
  await act(async () => video.dispatchEvent(new Event(type)));
}
function pointer(type: string, pointerId: number, clientX: number, clientY: number) {
  const result = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperties(result, {
    pointerId: { value: pointerId },
    clientX: { value: clientX },
    clientY: { value: clientY },
  });
  return result;
}
function prepareSelectionSurface() {
  const stage = container.querySelector<HTMLElement>('[data-testid="review-media-stage"]')!;
  Object.defineProperty(stage, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({ left: 0, top: 0, width: 360, height: 640 }),
  });
  const surface = container.querySelector<SVGSVGElement>('[aria-label="标注区域"]')!;
  const captures = new Set<number>();
  Object.defineProperties(surface, {
    setPointerCapture: { configurable: true, value: (pointerId: number) => captures.add(pointerId) },
    hasPointerCapture: { configurable: true, value: (pointerId: number) => captures.has(pointerId) },
    releasePointerCapture: { configurable: true, value: (pointerId: number) => captures.delete(pointerId) },
  });
  return surface;
}
it('a delayed seeking event does not erase the new frame already presented for that seek', async () => {
  await render();
  await present(2);
  await render('mark');
  expect(assigned).toHaveBeenLastCalledWith(2.12);
  // Actual Chrome trace: rVFC(seeking=true) -> seeking -> seeked.
  await present(2.12);
  await event('seeking');
  await event('seeked');
  expect(button().disabled).toBe(false);
});
it('seeking before presentation keeps selection unavailable until genuine frame metadata arrives', async () => {
  await render();
  await present(2);
  await render('mark');
  await event('seeking');
  await event('seeked');
  expect(button().disabled).toBe(true);
  await present(2.12);
  expect(button().disabled).toBe(false);
});
it('an owner refresh must not re-seek the active annotation or interrupt subsequent playback', async () => {
  await render();
  await present(2);
  await render('mark');
  await event('seeking');
  await event('seeked');
  await present(2.12);
  assigned.mockClear();
  playhead = 2.84;
  await render('mark', true);
  expect(assigned).not.toHaveBeenCalled();
  expect(playhead).toBe(2.84);
});
it('a repeated explicit focus on the same annotation still returns to its frame', async () => {
  await render();
  await present(2);
  await render('mark');
  await event('seeking');
  await event('seeked');
  await present(2.12);
  playhead = 2.84;
  await present(2.84);
  assigned.mockClear();
  focusRequest = { annotationId: 'mark' };
  await render('mark');
  expect(assigned).toHaveBeenLastCalledWith(2.12);
  expect(button().disabled).toBe(true);
  await present(2.12);
  await event('seeking');
  await event('seeked');
  expect(button().disabled).toBe(false);
});

it('lets a person open the same real discussion from its canvas mark with click or keyboard', async () => {
  await render();
  await act(async () => video.dispatchEvent(new Event('timeupdate')));
  const mark = container.querySelector<SVGGElement>('[data-testid="review-canvas-annotation-mark"]');
  expect(mark).not.toBeNull();
  expect(mark?.getAttribute('role')).toBe('button');
  expect(mark?.getAttribute('tabindex')).toBe('0');
  await act(async () => mark?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
  await act(async () => mark?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
  expect(onActive).toHaveBeenNthCalledWith(1, 'mark');
  expect(onActive).toHaveBeenNthCalledWith(2, 'mark');
});

it('ends a transient selection when mode, write access, or pointer ownership changes', async () => {
  await render();
  await present(2);
  await act(async () => video.dispatchEvent(new Event('timeupdate')));
  const mark = () => container.querySelector<SVGGElement>('[data-testid="review-canvas-annotation-mark"]');
  const beginSelection = async () =>
    act(async () => button().dispatchEvent(new MouseEvent('click', { bubbles: true })));

  await beginSelection();
  expect(mark()?.getAttribute('role')).toBeNull();
  await render(null, false, { mode: 'comment' });
  expect(mark()?.getAttribute('role')).toBe('button');

  await render();
  await beginSelection();
  await render(null, false, { canAnnotate: false });
  expect(mark()?.getAttribute('role')).toBe('button');

  await render();
  await beginSelection();
  const selectionSurface = container.querySelector<SVGSVGElement>('[aria-label="标注区域"]');
  await act(async () => selectionSurface?.dispatchEvent(new Event('pointercancel', { bubbles: true })));
  expect(mark()?.getAttribute('role')).toBe('button');
});

it('accepts a comment selection only from its original pointer and draft key', async () => {
  await render();
  await present(2);
  const surface = prepareSelectionSurface();
  await act(async () => button().dispatchEvent(new MouseEvent('click', { bubbles: true })));
  await act(async () => surface.dispatchEvent(pointer('pointerdown', 1, 20, 20)));
  await act(async () => surface.dispatchEvent(pointer('pointermove', 1, 140, 160)));
  await act(async () => surface.dispatchEvent(pointer('pointerdown', 2, 160, 180)));
  await act(async () => surface.dispatchEvent(pointer('pointermove', 2, 200, 220)));
  await act(async () => surface.dispatchEvent(pointer('pointerup', 2, 160, 180)));
  expect(onSelect).not.toHaveBeenCalled();
  await act(async () => surface.dispatchEvent(pointer('pointerup', 1, 140, 160)));
  expect(onSelect).toHaveBeenCalledTimes(1);

  onSelect.mockClear();
  await act(async () => button().dispatchEvent(new MouseEvent('click', { bubbles: true })));
  await act(async () => surface.dispatchEvent(pointer('pointerdown', 3, 20, 20)));
  await render(null, false, { selectionKey: 'annotation:two' });
  await act(async () => surface.dispatchEvent(pointer('pointerup', 3, 140, 160)));
  expect(onSelect).not.toHaveBeenCalled();
});

it('retires a comment selection when a focus request moves video to another presented frame', async () => {
  await render(null, false, { mode: 'comment' });
  await present(2);
  const surface = prepareSelectionSurface();
  await act(async () => surface.dispatchEvent(pointer('pointerdown', 1, 20, 20)));
  await act(async () => surface.dispatchEvent(pointer('pointermove', 1, 140, 160)));

  await render('mark', false, { mode: 'comment' });
  expect(assigned).toHaveBeenLastCalledWith(2.12);
  await present(2.12);
  await event('seeking');
  await event('seeked');
  await present(2);
  await event('seeked');
  await act(async () => surface.dispatchEvent(pointer('pointerup', 1, 140, 160)));

  expect(onSelect).not.toHaveBeenCalled();
});

it('cancels a comment gesture before a mode or authority transition can write it', async () => {
  await render();
  await present(2);
  const surface = prepareSelectionSurface();
  const begin = async (pointerId: number) => {
    await act(async () => button().dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await act(async () => surface.dispatchEvent(pointer('pointerdown', pointerId, 20, 20)));
    await act(async () => surface.dispatchEvent(pointer('pointermove', pointerId, 140, 160)));
  };

  await begin(1);
  await render(null, false, { mode: 'comment' });
  await act(async () => surface.dispatchEvent(pointer('pointerup', 1, 140, 160)));
  expect(onSelect).not.toHaveBeenCalled();

  await render(null, false, { mode: 'view' });
  await begin(2);
  await render(null, false, { mode: 'markup' });
  await act(async () => surface.dispatchEvent(pointer('pointerup', 2, 140, 160)));
  expect(onSelect).not.toHaveBeenCalled();

  await render(null, false, { mode: 'view' });
  await begin(3);
  await render(null, false, { canAnnotate: false });
  await act(async () => surface.dispatchEvent(pointer('pointerup', 3, 140, 160)));
  expect(onSelect).not.toHaveBeenCalled();

  await render(null, false, { mode: 'comment' });
  await act(async () => surface.dispatchEvent(pointer('pointerdown', 4, 20, 20)));
  await act(async () => surface.dispatchEvent(pointer('pointermove', 4, 140, 160)));
  await render(null, false, { mode: 'view' });
  await act(async () => surface.dispatchEvent(pointer('pointerup', 4, 140, 160)));
  expect(onSelect).not.toHaveBeenCalled();

  await render(null, false, { mode: 'comment' });
  await act(async () => surface.dispatchEvent(pointer('pointerdown', 5, 20, 20)));
  await act(async () => surface.dispatchEvent(pointer('pointermove', 5, 140, 160)));
  await render(null, false, { mode: 'markup' });
  await act(async () => surface.dispatchEvent(pointer('pointerup', 5, 140, 160)));
  expect(onSelect).not.toHaveBeenCalled();

  await render();
  await begin(6);
  await act(async () => surface.dispatchEvent(pointer('pointercancel', 6, 140, 160)));
  await act(async () => surface.dispatchEvent(pointer('pointerup', 6, 140, 160)));
  expect(onSelect).not.toHaveBeenCalled();

  await begin(7);
  await act(async () => surface.dispatchEvent(pointer('lostpointercapture', 7, 140, 160)));
  await act(async () => surface.dispatchEvent(pointer('pointerup', 7, 140, 160)));
  expect(onSelect).not.toHaveBeenCalled();
});
