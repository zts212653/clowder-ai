import { expect, it } from 'vitest';
import { createArtifactReviewSurface, resolveArtifactReviewTarget } from '../artifact-review-surface';
import { useF307ExperienceWorkbenchStore } from '../experience-workbench-store';
import { createMessagePublicationSurface } from '../message-publication-surface';
import { createPublicationSurface } from '../publication-surface';
import {
  createFileSurface,
  createNeedsMeReturnSurface,
  createWorkspaceModeSurface,
  isRealSurfaceOwnerAvailable,
} from '../real-surface-adapters';
import { resolveContentSurfaceIdentity } from '../resolve-content-surface';
import { createInitialWorkbenchState, reduceWorkbench } from '../workbench-model';
import { restoreWorkbenchState } from '../workbench-restore';

const publication = createPublicationSurface({
  contentRef: `prepared-media:${'a'.repeat(64)}`,
  ownerRevision: 1,
  title: '同一作品',
});
const review = createArtifactReviewSurface(`review-${'b'.repeat(64)}`, 'original-thread', '同一作品');
const weak = {
  ...publication,
  id: 'artifact:message-image',
  objectRef: { kind: 'artifact' as const, id: 'message-image' },
  ownerStateRef: { owner: 'f232', key: 'old-item' },
};
const user = { kind: 'user' as const, reason: 'workspace-home-selection' as const };
it('resolves a file artifact into the existing F063 host and preserves its actual return', () => {
  const file = createFileSurface({ worktreeId: 'original-root', path: 'code.ts' });
  const origin = { ...weak, returnTargetRef: { owner: 'f310-needs-me', key: 'original-item' } };
  const state = { ...createInitialWorkbenchState([file, origin]), activeSurfaceId: origin.id };
  const resolved = resolveContentSurfaceIdentity(state, origin.id, file);
  expect(resolved.surfaces).toHaveLength(1);
  expect(resolved.surfaces[0]?.resultTargetRef).toEqual(file.resultTargetRef);
  expect(resolved.surfaces[0]?.returnTargetRef).toEqual(origin.returnTargetRef);
  expect(resolved.activeSurfaceId).toBe(file.id);
  const changedFile = createFileSurface({ worktreeId: 'original-root', path: 'other.ts' });
  const late = resolveContentSurfaceIdentity({ ...state, activeSurfaceId: file.id }, origin.id, changedFile);
  expect(late.surfaces).toEqual([file]);
});
it('restores the selected file entrance and original Needs Me return after reload', () => {
  const needsMe = createNeedsMeReturnSurface(createWorkspaceModeSurface('needs-me', 'task-thread'), 'actual-item')!;
  const source = { ...weak, returnTargetRef: needsMe.resultTargetRef };
  const file = {
    ...createFileSurface({ worktreeId: 'chosen-root', path: 'notes.md' }),
    artifactFileSource: {
      threadId: 'source-thread',
      artifactId: 'original-artifact',
      path: 'notes.md',
      title: '笔记',
      selectedLocation: { absolutePath: '/chosen/notes.md', label: 'chosen' },
    },
  };
  const resolved = resolveContentSurfaceIdentity(createInitialWorkbenchState([source]), source.id, file);
  const restored = restoreWorkbenchState(resolved, { isOwnerRefAvailable: isRealSurfaceOwnerAvailable });
  expect(restored.surfaces[0]?.artifactFileSource).toEqual(file.artifactFileSource);
  expect(restored.surfaces[0]?.returnTargetRef).toEqual(needsMe.resultTargetRef);
  const returned = reduceWorkbench(restored, {
    type: 'close-artifact-to-return',
    artifactSurfaceId: file.id,
    entitlement: { kind: 'user', reason: 'close-button' },
  });
  expect(returned.surfaces.at(-1)?.resultTargetRef).toEqual(needsMe.resultTargetRef);
});
it('restores an artifact-list return through file resolution with exact scope and query', () => {
  const navigationOrigin = {
    kind: 'artifact-list' as const,
    threadId: 'original-list',
    view: {
      scope: 'global' as const,
      filter: 'codepr' as const,
      query: 'proposal',
      grouping: 'thread' as const,
      catFilter: 'opus5',
      collapsed: ['unrelated'],
    },
  };
  const file = createFileSurface({ worktreeId: 'original-root', path: 'proposal.ts' });
  const source = { ...weak, navigationOrigin };
  const resolved = resolveContentSurfaceIdentity(createInitialWorkbenchState([source]), source.id, file);
  const restored = restoreWorkbenchState(resolved, { isOwnerRefAvailable: isRealSurfaceOwnerAvailable });
  expect(restored.surfaces[0]?.navigationOrigin).toEqual(navigationOrigin);
  const list = {
    ...createWorkspaceModeSurface('artifacts', navigationOrigin.threadId),
    artifactListView: navigationOrigin.view,
  };
  expect(
    restoreWorkbenchState(createInitialWorkbenchState([list]), { isOwnerRefAvailable: isRealSurfaceOwnerAvailable })
      .surfaces[0]?.artifactListView,
  ).toEqual(navigationOrigin.view);
});
it('retains the exact message selector across resolved contexts and reload without inferring it from URL', () => {
  const source = {
    kind: 'message' as const,
    threadId: 'source',
    messageId: 'message',
    messageRevision: '42',
    expectedUrl: '/uploads/same.png',
    item: { kind: 'media-gallery' as const, blockId: 'gallery', itemIndex: 2 },
  };
  const message = createMessagePublicationSurface(source, '原作品');
  const opened = resolveContentSurfaceIdentity(createInitialWorkbenchState([message]), message.id, publication);
  const switched = resolveContentSurfaceIdentity(opened, publication.id, review);
  const restored = restoreWorkbenchState(switched, { isOwnerRefAvailable: isRealSurfaceOwnerAvailable });
  expect(restored.surfaces[0]?.messagePublicationSource).toEqual(source);
});
it('restores an explicit historical Task round through the real owner availability and persisted descriptor path', () => {
  const historical = createArtifactReviewSurface(`review-${'d'.repeat(64)}`, 'thread-history', '历史作品', 2);
  const restored = restoreWorkbenchState(createInitialWorkbenchState([historical]), {
    isOwnerRefAvailable: isRealSurfaceOwnerAvailable,
  });
  expect(restored.surfaces).toHaveLength(1);
  expect(resolveArtifactReviewTarget(restored.surfaces[0]!)).toEqual({
    reviewId: `review-${'d'.repeat(64)}`,
    threadId: 'thread-history',
    round: 2,
  });
});
it('retains the original message return through context switching and persisted review restoration', () => {
  const source = {
    ...publication,
    navigationOrigin: { kind: 'chat-file-link' as const, threadId: 'source-thread', messageId: 'source-message' },
  };
  const opened = resolveContentSurfaceIdentity(createInitialWorkbenchState([source]), source.id, review);
  const next = createArtifactReviewSurface(`review-${'c'.repeat(64)}`, 'another-task-thread', '同一作品', 2);
  const switched = resolveContentSurfaceIdentity(opened, review.id, next);
  const restored = restoreWorkbenchState(switched, { isOwnerRefAvailable: isRealSurfaceOwnerAvailable });
  expect(restored.surfaces).toHaveLength(1);
  expect(restored.surfaces[0]?.navigationOrigin).toEqual(source.navigationOrigin);
  expect(resolveArtifactReviewTarget(restored.surfaces[0]!)).toEqual({
    reviewId: next.objectRef.id,
    threadId: 'another-task-thread',
    round: 2,
  });
});
it('preserves an explicit enlargement across owner resolution without introducing automatic attention', () => {
  const store = useF307ExperienceWorkbenchStore,
    original = store.getState();
  try {
    store.setState({ layout: createInitialWorkbenchState([weak]), hydrated: true, mainAreaAttentionSurfaceId: null });
    store.getState().dispatch({ type: 'resolve-content-surface', sourceSurfaceId: weak.id, surface: publication });
    expect(store.getState().mainAreaAttentionSurfaceId).toBeNull();
    store.setState({ layout: createInitialWorkbenchState([weak]), mainAreaAttentionSurfaceId: null });
    store.getState().enterMainAreaAttention(weak.id);
    store.getState().dispatch({ type: 'resolve-content-surface', sourceSurfaceId: weak.id, surface: publication });
    expect(store.getState().mainAreaAttentionSurfaceId).toBe(publication.id);
  } finally {
    store.setState(original, true);
  }
});
it('resolves a weak artifact entrance onto the existing canonical session and removes the duplicate host identity', () => {
  let state = createInitialWorkbenchState([publication]);
  state = reduceWorkbench(state, { type: 'open-surface', surface: weak, entitlement: user });
  state = {
    ...state,
    split: { primarySurfaceId: publication.id, secondarySurfaceId: weak.id },
    pinnedSurfaceIds: [weak.id, publication.id],
  };
  const result = resolveContentSurfaceIdentity(state, weak.id, publication);
  expect(result.surfaces.map((item) => item.id)).toEqual([publication.id]);
  expect(result.activeSurfaceId).toBe(publication.id);
  expect(result.split).toBeNull();
  expect(result.pinnedSurfaceIds).toEqual([publication.id]);
  expect(result.recentlyClosed.some((item) => item.id === weak.id)).toBe(false);
  expect(resolveContentSurfaceIdentity(result, weak.id, publication)).toBe(result);
});
it('reuses a retained Task context, preserves its return edge, and does not steal focus after the source was left', () => {
  const origin = { ...publication, returnTargetRef: { owner: 'thread', key: 'original-needs-me' } };
  const another = createPublicationSurface({
    contentRef: `prepared-media:${'c'.repeat(64)}`,
    ownerRevision: 1,
    title: '正在看的作品',
  });
  const state = {
    ...createInitialWorkbenchState([origin, another]),
    activeSurfaceId: another.id,
    recentlyClosed: [review],
  };
  const result = resolveContentSurfaceIdentity(state, origin.id, review);
  expect(result.surfaces.map((item) => item.id)).toEqual([review.id, another.id]);
  expect(result.surfaces[0]?.returnTargetRef).toEqual(origin.returnTargetRef);
  expect(result.recentlyClosed).toEqual([]);
  expect(result.activeSurfaceId).toBe(another.id);
  expect(resolveContentSurfaceIdentity({ ...state, surfaces: [another] }, origin.id, review).surfaces).toEqual([
    another,
  ]);
});
it('a late hidden alias cannot switch the version or return position of an already active canonical review', () => {
  const current = {
    ...createArtifactReviewSurface(review.objectRef.id, 'original-thread', '同一作品', 2),
    navigationOrigin: { kind: 'chat-file-link' as const, threadId: 'current-thread', messageId: 'current-message' },
  };
  const state = { ...createInitialWorkbenchState([weak, current]), activeSurfaceId: current.id };
  const old = createArtifactReviewSurface(review.objectRef.id, 'original-thread', '同一作品', 1);
  const resolved = resolveContentSurfaceIdentity(state, weak.id, old);
  expect(resolved.surfaces).toEqual([current]);
  expect(resolved.surfaces[0]).toBe(current);
});
