import type { ReactNode } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mediaView, revision } from '../content-review/__tests__/WorkspaceContentReviewSurface.fixture';
import type { WorkspaceAnnotationTarget } from '../content-review/workspace-review-draft';
import { workspaceReviewDraftKey } from '../content-review/workspace-review-draft';
import { useF307ExperienceWorkbenchStore } from '../experience-workbench-store';
import { F307OwnerSurfaceRenderer } from '../F307OwnerSurfaceRenderer';
import { createPublicationSurface } from '../publication-surface';
import { createInitialWorkbenchState } from '../workbench-model';

const mocks = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock('@/components/shell/shell-presentation', () => ({ useShellPresentation: () => 'v2' }));
vi.mock('@/utils/api-client', () => ({
  API_URL: 'http://fixture.test',
  apiFetch: (...args: unknown[]) => mocks.apiFetch(...args),
}));
vi.mock('../ContentPublicationNavigator', () => ({
  ContentPublicationNavigator: ({ children }: { children: ReactNode | ((leadingAction?: ReactNode) => ReactNode) }) =>
    typeof children === 'function' ? children() : children,
}));
vi.mock('../PublicationLandingResolver', () => ({
  PublicationLandingResolver: ({ children }: { children: ReactNode }) => children,
}));
vi.mock('../content-review/WorkspaceContentReviewProjection', () => ({
  WorkspaceContentReviewProjection: ({
    setTarget,
    setDraft,
    setActiveAnnotationId,
  }: {
    setTarget: (target: WorkspaceAnnotationTarget | null) => void;
    setDraft: (draft: string) => void;
    setActiveAnnotationId: (id: string | null) => void;
  }) => (
    <div data-testid="original-publication-owner">
      <button
        type="button"
        onClick={() => setTarget({ kind: 'media_anchor', anchor: { kind: 'image-point', x: 32, y: 48 } })}
      >
        选择批注点
      </button>
      <button type="button" onClick={() => setDraft('未提交的原批注草稿')}>
        写批注
      </button>
      <button type="button" onClick={() => setActiveAnnotationId('existing-annotation')}>
        查看已有批注
      </button>
      <button type="button" onClick={() => setTarget(null)}>
        清空选区
      </button>
    </div>
  ),
}));

const contentRef = `prepared-media:${'e'.repeat(64)}`;
const publication = createPublicationSurface({ contentRef, ownerRevision: 1, title: '图片 · 小太阳 10:42' });
function fixture() {
  const value = mediaView();
  const source = value.review.source;
  if (source.kind !== 'media') throw new Error('The original fixture must be media');
  value.review.source = {
    kind: 'publication',
    revision,
    mime: source.mime,
    media: source.media,
    publication: {
      contentRef,
      ownerRevision: 1,
      blobDigest: revision,
      ownerReceiptRef: 'fixture-receipt',
      sourcePublication: {
        artifactRef: '/uploads/fixture.png',
        sourceRef: 'message:original:publication',
        revision: '1',
      },
    },
  };
  return { ...value, currentSource: value.review.source };
}
let container: HTMLDivElement, root: Root;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  useF307ExperienceWorkbenchStore.setState({
    layout: { ...createInitialWorkbenchState([publication]), previewSurfaceId: publication.id },
    hydrated: true,
  });
  mocks.apiFetch.mockReset().mockImplementation(async (url: string) => {
    const value = fixture();
    if (url.startsWith('/api/content-publications/')) {
      const source = value.review.source;
      if (source.kind !== 'publication') throw new Error('The source must remain a publication');
      return new Response(
        JSON.stringify({
          asset: { ...source.publication, mediaType: source.mime, media: source.media },
          currentOwnerRevision: 1,
        }),
      );
    }
    if (url === '/api/content-reviews/prepare') return new Response(JSON.stringify(value));
    throw new Error(`Unexpected fixture route: ${url}`);
  });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  localStorage.clear();
});
async function render() {
  await act(async () => {
    root.render(
      <F307OwnerSurfaceRenderer
        surface={publication}
        onOpenSurface={vi.fn()}
        onOpenArtifactWithReturn={vi.fn()}
        onRefreshSurface={vi.fn()}
        onRequestDetach={vi.fn()}
      />,
    );
    for (let index = 0; index < 12; index++) await Promise.resolve();
  });
  expect(container.querySelector('[data-testid="original-publication-owner"]')).not.toBeNull();
}
function click(label: string) {
  const button = [...container.querySelectorAll('button')].find((node) => node.textContent === label);
  if (!button) throw new Error(`The original publication action is missing: ${label}`);
  act(() => button.click());
}
it('keeps passive publication reads and existing-annotation inspection in preview', async () => {
  await render();
  click('查看已有批注');
  click('清空选区');
  expect(useF307ExperienceWorkbenchStore.getState().layout.previewSurfaceId).toBe(publication.id);
});
it('promotes a publication at its first annotation anchor before a body is typed', async () => {
  await render();
  click('选择批注点');
  const draft = JSON.parse(localStorage.getItem(workspaceReviewDraftKey(fixture())) ?? 'null');
  expect(draft).toMatchObject({
    body: '',
    target: { kind: 'media_anchor', anchor: { kind: 'image-point', x: 32, y: 48 } },
  });
  expect(useF307ExperienceWorkbenchStore.getState().layout.previewSurfaceId).toBeNull();
  expect(useF307ExperienceWorkbenchStore.getState().layout.surfaces[0]).toBe(publication);
});
it('promotes through the existing draft callback without relying on a bubbling DOM input', async () => {
  await render();
  click('写批注');
  expect(JSON.parse(localStorage.getItem(workspaceReviewDraftKey(fixture())) ?? 'null').body).toBe(
    '未提交的原批注草稿',
  );
  expect(useF307ExperienceWorkbenchStore.getState().layout.previewSurfaceId).toBeNull();
  expect(useF307ExperienceWorkbenchStore.getState().layout.surfaces[0]).toBe(publication);
});
