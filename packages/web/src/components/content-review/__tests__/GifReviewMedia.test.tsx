import type { ImmutableMedia } from '@cat-cafe/shared';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { writeShellPresentation } from '@/components/shell/shell-presentation';
import { WorkspaceContentReviewMedia } from '@/components/workbench/content-review/WorkspaceContentReviewMedia';
import { ArtworkOpeningPreview } from '../ArtworkOpeningPreview';

let root: ReturnType<typeof createRoot>, container: HTMLDivElement;
const selected = vi.fn(),
  saved = vi.fn();
const media: ImmutableMedia = {
  kind: 'image',
  width: 160,
  height: 100,
  animation: { frameCount: 2, frameDelaysMs: [80, 230], durationMs: 310, loopCount: 0 },
};
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal(
    'requestAnimationFrame',
    vi.fn(() => 1),
  );
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  writeShellPresentation('v2');
  selected.mockClear();
  saved.mockClear();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  writeShellPresentation('classic');
});
async function mount(opening = false) {
  const view = createElement(WorkspaceContentReviewMedia, {
    reviewId: 'gif-review',
    sourceRevision: 'version-one',
    src: '/media/1?display=gif-frames',
    originalUrl: '/media/1',
    mime: 'image/gif',
    media,
    imageChatPrimary: true,
    annotations: [],
    annotationResolutions: [],
    visualMarks: [],
    visualMarkResolutions: [],
    activeAnnotationId: null,
    canWrite: true,
    selected: null,
    composer: null,
    draftKey: 'gif-test-one',
    onAnchorSelected: selected,
    onAnnotationActive: vi.fn(),
    onSaveVisualMarks: saved,
    onDeleteVisualMark: vi.fn(),
    onOpenDiscussion: vi.fn(),
  });
  await act(async () =>
    root.render(
      opening ? (
        <ArtworkOpeningPreview
          work={{
            url: '/original.gif',
            alt: '原 GIF',
            title: '原 GIF',
            mediaType: 'image',
            surface: null,
            pending: true,
          }}
        >
          {view}
        </ArtworkOpeningPreview>
      ) : (
        view
      ),
    ),
  );
}
const button = (label: string) => container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
async function drag(selector: string) {
  const stage = container.querySelector<HTMLElement>('[data-testid="review-media-stage"]')!;
  const overlay = container.querySelector<SVGSVGElement>(selector)!;
  const bounds = { x: 0, y: 0, left: 0, top: 0, right: 160, bottom: 100, width: 160, height: 100, toJSON() {} };
  vi.spyOn(stage, 'getBoundingClientRect').mockReturnValue(bounds);
  vi.spyOn(overlay, 'getBoundingClientRect').mockReturnValue(bounds);
  overlay.setPointerCapture = vi.fn();
  overlay.hasPointerCapture = () => false;
  for (const [type, x, y] of [
    ['pointerdown', 10, 10],
    ['pointermove', 60, 50],
    ['pointerup', 60, 50],
  ] as const) {
    const event = new MouseEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0 });
    Object.defineProperty(event, 'pointerId', { value: 1 });
    await act(async () => overlay.dispatchEvent(event));
  }
}
it('blocks selection until actual frame pixels load, then binds a region to the stepped frame clock', async () => {
  await mount();
  expect(button('下一帧')).not.toBeNull();
  expect(button('下一帧')!.disabled).toBe(true);
  const image = container.querySelector<HTMLImageElement>('[data-testid="gif-frame-media"] img')!;
  await act(async () => image.dispatchEvent(new Event('load')));
  await act(async () => button('下一帧')!.click());
  expect(container.querySelector('[data-testid="gif-frame-media"]')?.getAttribute('data-frame-index')).toBe('1');
  const circle = [...container.querySelectorAll<HTMLButtonElement>('button')].find(
    (item) => item.textContent === '圈选',
  )!;
  await act(async () => circle.click());
  await drag('[aria-label="图片或视频上的批注"]');
  expect(selected).toHaveBeenCalledWith({
    kind: 'image-region',
    x: 10,
    y: 10,
    width: 50,
    height: 40,
    frameIndex: 1,
    timestampMs: 80,
  });
  expect(button('播放 GIF')).not.toBeNull();
});

it('hands the Chat preview over only after its actual GIF frame projection decodes', async () => {
  await mount(true);
  expect(container.querySelector('[data-testid="artwork-chat-preview"]')).not.toBeNull();
  const img = container.querySelector<HTMLImageElement>('[data-testid="workspace-content-review-media"]')!;
  Object.defineProperties(img, {
    complete: { configurable: true, value: true },
    currentSrc: { configurable: true, get: () => img.src },
    naturalWidth: { configurable: true, value: 320 },
    naturalHeight: { configurable: true, value: 100 },
    decode: { configurable: true, value: () => Promise.resolve() },
  });
  await act(async () => {
    img.dispatchEvent(new Event('load'));
    await Promise.resolve();
  });
  expect(container.querySelector('[data-testid="artwork-chat-preview"]')).toBeNull();
  expect(button('下一帧')?.closest('[aria-hidden="true"]')).toBeNull();
  expect(button('下一帧')!.disabled).toBe(false);
});
