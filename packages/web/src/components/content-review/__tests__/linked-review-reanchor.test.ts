import type { ArtifactReviewRound } from '@cat-cafe/shared';
import { beforeEach, expect, it, vi } from 'vitest';
import { mediaView } from '@/components/workbench/content-review/__tests__/WorkspaceContentReviewSurface.fixture';
import { workspaceReviewDraftKey } from '@/components/workbench/content-review/workspace-review-draft';
import { startArtifactReanchor } from '../startArtifactReanchor';

const api = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('@/utils/api-client', () => ({ apiFetch: (...args: unknown[]) => api.fetch(...args) }));
beforeEach(() => {
  localStorage.clear();
  api.fetch.mockReset();
});
it('does not conceal a draft already held by the latest publication when reanchoring an old Task comment', async () => {
  const view = mediaView(),
    source = view.review.source;
  if (source.kind !== 'media') throw Error('expected image');
  const publication = {
    contentRef: `prepared-media:${'a'.repeat(64)}`,
    ownerRevision: 2,
    blobDigest: source.revision,
    ownerReceiptRef: 'owner-receipt',
    sourcePublication: { sourceRef: 'message:thread:latest', artifactRef: '/uploads/latest.png', revision: '2' },
  };
  view.review.source = {
    kind: 'publication',
    revision: source.revision,
    mime: 'image/png',
    media: source.media,
    publication,
  };
  const round: ArtifactReviewRound = {
    number: 2,
    openedAt: '2026-09-20T00:00:00Z',
    state: 'draft',
    annotations: [],
    responses: [],
    asset: { ...publication, media: source.media, mediaType: 'image/png' },
    ledgerRef: view.review.reviewId,
    ledgerRevision: view.review.revision,
  };
  api.fetch.mockImplementation(async () => new Response(JSON.stringify(view)));
  const key = workspaceReviewDraftKey(view);
  const original = {
    v: 1,
    body: '原位仍在写的草稿',
    target: null,
    activeAnnotationId: null,
    annotation: null,
    action: null,
    refresh: null,
  };
  localStorage.setItem(key, JSON.stringify(original));
  const reanchor = { body: '旧版意见', anchor: null, reanchoredFrom: { round: 1, annotationId: 'old' } };
  expect(await startArtifactReanchor('old-task:', round, reanchor)).toBe('existing');
  expect(JSON.parse(localStorage.getItem(key) ?? 'null')).toEqual(original);
  expect(localStorage.getItem('old-task:round:2:annotation')).toBeNull();
  localStorage.removeItem(key);
  expect(await startArtifactReanchor('old-task:', round, reanchor)).toBe('created');
  expect(JSON.parse(localStorage.getItem('old-task:round:2:annotation') ?? 'null')).toEqual(reanchor);
});
