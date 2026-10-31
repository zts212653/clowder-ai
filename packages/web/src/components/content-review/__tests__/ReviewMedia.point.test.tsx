import type { ReviewedMediaAsset } from '@cat-cafe/shared';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { WorkspaceContentReviewMedia } from '@/components/workbench/content-review/WorkspaceContentReviewMedia';

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
      createElement(WorkspaceContentReviewMedia, {
        reviewId: 'review',
        sourceRevision: asset.blobDigest,
        src: 'blob:image',
        media: asset.media,
        annotations: [],
        annotationResolutions: [],
        visualMarks: [],
        visualMarkResolutions: [],
        selected: null,
        composer: null,
        activeAnnotationId: null,
        canWrite: true,
        onAnchorSelected: select,
        onAnnotationActive: vi.fn(),
        onSaveVisualMarks: vi.fn(),
        onDeleteVisualMark: vi.fn(),
        onOpenDiscussion: vi.fn(),
      }),
    ),
  );
  await act(async () => host.querySelector<HTMLButtonElement>('[data-mode="comment"]')?.click());
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
  const svg = host.querySelector<SVGSVGElement>('[aria-label="图片或视频上的批注"]')!;
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
