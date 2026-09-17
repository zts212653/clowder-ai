import type { ReviewedMediaAsset } from '@cat-cafe/shared';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ReviewMedia } from '../ReviewMedia';

vi.mock('../useReviewMediaSource', () => ({
  useReviewMediaSource: () => ({ src: 'blob:image', error: null, setError: vi.fn() }),
}));
const asset: ReviewedMediaAsset = {
  contentRef: 'cover',
  ownerRevision: 1,
  blobDigest: `sha256:${'a'.repeat(64)}`,
  mediaType: 'image/png',
  media: { kind: 'image', width: 800, height: 600 },
  sourcePublication: { artifactRef: '/uploads/cover.png', sourceRef: 'message:cover', revision: '1' },
  ownerReceiptRef: 'receipt',
};
let host: HTMLDivElement, root: ReturnType<typeof createRoot>;
const select = vi.fn();
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  select.mockClear();
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});

async function render() {
  await act(async () =>
    root.render(
      createElement(ReviewMedia, {
        reviewId: 'review',
        round: 1,
        asset,
        annotations: [],
        selected: null,
        focusRequest: null,
        canAnnotate: true,
        onSelect: select,
        onActive: vi.fn(),
        mode: 'comment',
        selectionKey: 'one',
        onUnavailable: vi.fn(),
      }),
    ),
  );
  const stage = host.querySelector<HTMLDivElement>('[data-testid="review-media-stage"]')!;
  vi.spyOn(stage, 'getBoundingClientRect').mockReturnValue({
    x: 10,
    y: 20,
    left: 10,
    top: 20,
    right: 410,
    bottom: 320,
    width: 400,
    height: 300,
    toJSON: () => ({}),
  });
  const svg = host.querySelector<SVGSVGElement>('[aria-label="标注区域"]')!;
  svg.setPointerCapture = vi.fn();
  svg.hasPointerCapture = () => false;
  svg.releasePointerCapture = vi.fn();
  return svg;
}
async function pointer(svg: SVGSVGElement, type: string, x: number, y: number) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperties(event, { pointerId: { value: 1 }, clientX: { value: x }, clientY: { value: y } });
  await act(async () => svg.dispatchEvent(event));
}

it('a click makes a real media point at the projected location; a drag still makes a region', async () => {
  const svg = await render();
  await pointer(svg, 'pointerdown', 110, 95);
  await pointer(svg, 'pointerup', 110, 95);
  expect(select).toHaveBeenLastCalledWith({ kind: 'image-point', x: 200, y: 150 });
  await pointer(svg, 'pointerdown', 110, 95);
  await pointer(svg, 'pointermove', 210, 145);
  await pointer(svg, 'pointerup', 210, 145);
  expect(select).toHaveBeenLastCalledWith({ kind: 'image-region', x: 200, y: 150, width: 200, height: 100 });
});

it('a cancelled tap and a drag returning to its start cannot create accidental point comments', async () => {
  const svg = await render();
  await pointer(svg, 'pointerdown', 110, 95);
  await pointer(svg, 'pointercancel', 110, 95);
  await pointer(svg, 'pointerup', 110, 95);
  expect(select).not.toHaveBeenCalled();
  await pointer(svg, 'pointerdown', 110, 95);
  await pointer(svg, 'pointermove', 210, 145);
  await pointer(svg, 'pointerup', 110, 95);
  expect(select).not.toHaveBeenCalled();
});
