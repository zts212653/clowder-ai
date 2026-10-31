import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { WorkspaceContentReviewMedia } from '../content-review/WorkspaceContentReviewMedia';
import { useF307ExperienceWorkbenchStore } from '../experience-workbench-store';
import { createPublicationSurface } from '../publication-surface';
import { WorkspacePreviewIntentProvider } from '../WorkspacePreviewIntent';
import { createInitialWorkbenchState } from '../workbench-model';

vi.mock('@/components/content-review/ReviewMediaOverlay', () => ({
  ReviewMediaOverlay: ({ markup }: { markup: { onDrawStart: () => void } | null }) =>
    markup ? (
      <button type="button" data-testid="original-start-stroke" onClick={markup.onDrawStart}>
        开始一笔
      </button>
    ) : null,
}));
vi.mock('../content-review/WorkspaceReviewMediaElement', () => ({
  WorkspaceReviewMediaElement: () => <div data-testid="original-image" />,
}));

const surface = createPublicationSurface({
  contentRef: `prepared-media:${'d'.repeat(64)}`,
  ownerRevision: 1,
  title: '图片',
});
let container: HTMLDivElement, root: Root;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  useF307ExperienceWorkbenchStore.setState({
    layout: { ...createInitialWorkbenchState([surface]), previewSurfaceId: surface.id },
    hydrated: true,
  });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  act(() =>
    root.render(
      <WorkspacePreviewIntentProvider surfaceId={surface.id}>
        <WorkspaceContentReviewMedia
          reviewId="preview-markup"
          sourceRevision={`sha256:${'a'.repeat(64)}`}
          src="/fixture.png"
          media={{ kind: 'image', width: 160, height: 100 }}
          annotations={[]}
          annotationResolutions={[]}
          visualMarks={[]}
          visualMarkResolutions={[]}
          activeAnnotationId={null}
          canWrite
          onAnchorSelected={vi.fn()}
          onAnnotationActive={vi.fn()}
          onSaveVisualMarks={async () => true}
          onDeleteVisualMark={async () => true}
          selected={null}
          composer={null}
          onOpenDiscussion={vi.fn()}
        />
      </WorkspacePreviewIntentProvider>,
    ),
  );
  const mode = container.querySelector<HTMLButtonElement>('[data-mode="markup"]');
  if (!mode) throw new Error('The original markup mode is unavailable');
  act(() => mode.click());
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  localStorage.clear();
});
it('keeps merely opening the markup tools in preview', () => {
  expect(container.querySelector('[data-testid="original-start-stroke"]')).not.toBeNull();
  expect(useF307ExperienceWorkbenchStore.getState().layout.previewSurfaceId).toBe(surface.id);
});
it('promotes the same owner when its original canvas starts a stroke before save or text input', () => {
  const drawing = container.querySelector<HTMLButtonElement>('[data-testid="original-start-stroke"]');
  if (!drawing) throw new Error('The original stroke callback is unavailable');
  act(() => drawing.click());
  expect(useF307ExperienceWorkbenchStore.getState().layout.previewSurfaceId).toBeNull();
  expect(useF307ExperienceWorkbenchStore.getState().layout.surfaces[0]).toBe(surface);
});
