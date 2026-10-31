import { afterEach, expect, it } from 'vitest';
import { createMessagePublicationSurface } from '../message-publication-surface';
import { createPublicationSurface } from '../publication-surface';
import { createFileSurface, isRealSurfaceOwnerAvailable } from '../real-surface-adapters';
import type { WorkbenchAction, WorkspaceSurfaceDescriptor } from '../workbench-contract';
import { createInitialWorkbenchState, reduceWorkbench, restoreWorkbenchState } from '../workbench-model';
import { loadWorkbenchState, WORKBENCH_STORAGE_KEY, writeWorkbenchState } from '../workbench-persistence';

const originA = { kind: 'chat-file-link', threadId: 'thread-preview', messageId: 'message-a' } as const;
const originB = { ...originA, messageId: 'message-b' };
const file = createFileSurface({ worktreeId: 'preview-lifecycle', path: 'guide.md' });
const first = createPublicationSurface({
  contentRef: `prepared-media:${'a'.repeat(64)}`,
  ownerRevision: 1,
  title: 'A',
  navigationOrigin: originA,
});
const second = createPublicationSurface({
  contentRef: `prepared-media:${'b'.repeat(64)}`,
  ownerRevision: 2,
  title: 'B',
  navigationOrigin: originB,
});
const user = { kind: 'user', reason: 'open-from-chat' } as const;
// These runtime regressions precede adding preview commands to the typed contract.
function openPreview(surface: WorkspaceSurfaceDescriptor, background = false): WorkbenchAction {
  return {
    type: 'open-preview-surface',
    surface,
    entitlement: background ? { kind: 'background', reason: 'owner-background' } : user,
  } as unknown as WorkbenchAction;
}

afterEach(() => localStorage.removeItem(WORKBENCH_STORAGE_KEY));

it('replaces the declared preview at its own index and atomically remaps active and split owners', () => {
  const state = {
    ...createInitialWorkbenchState([first, file]),
    previewSurfaceId: first.id,
    activeSurfaceId: first.id,
    split: { primarySurfaceId: file.id, secondarySurfaceId: first.id },
  };
  const replaced = reduceWorkbench(state, openPreview(second));
  expect(replaced.surfaces).toEqual([second, file]);
  expect(replaced).toMatchObject({ previewSurfaceId: second.id, activeSurfaceId: second.id });
  expect(replaced.split).toEqual({ primarySurfaceId: file.id, secondarySurfaceId: second.id });
  expect(replaced.surfaces[0]?.navigationOrigin).toBe(originB);
  expect(replaced.recentlyClosed).toContainEqual(first);
  expect(replaced.sidecar).toBeNull();
});

it('promotes a preview without remounting its owner or changing its original return coordinate', () => {
  const state = { ...createInitialWorkbenchState([first, file]), previewSurfaceId: first.id };
  const promoted = reduceWorkbench(state, {
    type: 'promote-preview-surface',
    surfaceId: first.id,
    entitlement: user,
  } as unknown as WorkbenchAction);
  expect(promoted).toMatchObject({ previewSurfaceId: null });
  expect(promoted.surfaces).toBe(state.surfaces);
  expect(promoted.activeSurfaceId).toBe(first.id);
  const next = reduceWorkbench(promoted, openPreview(second));
  expect(next.surfaces).toEqual([first, file, second]);
  expect(next.surfaces[0]).toBe(first);
});

it('pinning promotes the preview and unpinning never silently turns a permanent owner back into a preview', () => {
  const state = { ...createInitialWorkbenchState([first, file]), previewSurfaceId: first.id };
  const pinned = reduceWorkbench(state, {
    type: 'pin-surface',
    surfaceId: first.id,
    pinned: true,
    entitlement: user,
  });
  expect(pinned).toMatchObject({ previewSurfaceId: null, pinnedSurfaceIds: [first.id] });
  const unpinned = reduceWorkbench(pinned, {
    type: 'pin-surface',
    surfaceId: first.id,
    pinned: false,
    entitlement: user,
  });
  expect(unpinned).toMatchObject({ previewSurfaceId: null, pinnedSurfaceIds: [] });
  expect(reduceWorkbench(unpinned, openPreview(second)).surfaces).toEqual([first, file, second]);
});

it('clears a detached slot so the next preview cannot replace an unrelated permanent owner', () => {
  const state = { ...createInitialWorkbenchState([first, file]), previewSurfaceId: first.id };
  const closed = reduceWorkbench(state, { type: 'close-surface', surfaceId: first.id, entitlement: user });
  expect(closed).toMatchObject({ previewSurfaceId: null, surfaces: [file] });
  expect(reduceWorkbench(closed, openPreview(second)).surfaces).toEqual([file, second]);
});

it('keeps the declared user preview and focus when a background arrival becomes available', () => {
  const state = { ...createInitialWorkbenchState([first, file]), previewSurfaceId: first.id };
  const arrived = reduceWorkbench(state, openPreview(second, true));
  expect(arrived.surfaces).toBe(state.surfaces);
  expect(arrived).toMatchObject({ previewSurfaceId: first.id, activeSurfaceId: first.id });
  expect(arrived.activity).toContainEqual(expect.objectContaining({ surfaceId: second.id, surface: second }));
});

it('remaps the same preview when an exact message item resolves into its canonical publication', () => {
  const unresolved = createMessagePublicationSurface(
    {
      kind: 'message',
      threadId: 'thread-preview',
      messageId: 'message-a',
      messageRevision: '1',
      expectedUrl: '/uploads/preview-a.png',
      item: { kind: 'content-block', index: 0 },
    },
    'A',
  );
  const state = {
    ...createInitialWorkbenchState([unresolved, file]),
    previewSurfaceId: unresolved.id,
    split: { primarySurfaceId: file.id, secondarySurfaceId: unresolved.id },
  };
  const resolved = reduceWorkbench(state, {
    type: 'resolve-content-surface',
    sourceSurfaceId: unresolved.id,
    surface: first,
  });
  expect(resolved).toMatchObject({ previewSurfaceId: first.id, activeSurfaceId: first.id });
  expect(resolved.split).toEqual({ primarySurfaceId: file.id, secondarySurfaceId: first.id });
  expect(resolved.surfaces[0]?.messagePublicationSource?.messageId).toBe('message-a');
  expect(reduceWorkbench(resolved, openPreview(second)).surfaces).toEqual([second, file]);
});

it('persists the explicit preview and exact origin through the existing layout storage without expiry', () => {
  const state = { ...createInitialWorkbenchState([first, file]), previewSurfaceId: first.id };
  writeWorkbenchState(localStorage, state);
  const loaded = loadWorkbenchState({ storage: localStorage, isOwnerRefAvailable: isRealSurfaceOwnerAvailable });
  expect(loaded.layout).toMatchObject({ previewSurfaceId: first.id, surfaces: [first, file] });
  expect(loaded.layout.surfaces[0]?.navigationOrigin).toEqual(originA);
  expect(JSON.parse(localStorage.getItem(WORKBENCH_STORAGE_KEY) ?? '{}')).not.toHaveProperty('expiresAt');
});

it.each([undefined, 'missing-owner', file.id])('restores old or invalid preview references as no slot: %s', (id) => {
  const state = { ...createInitialWorkbenchState([first, file]), pinnedSurfaceIds: [file.id], previewSurfaceId: id };
  expect(restoreWorkbenchState(state)).toMatchObject({ previewSurfaceId: null, surfaces: [first, file] });
});

it('clears preview membership when bulk closing its host while retaining the pinned working set', () => {
  const state = {
    ...createInitialWorkbenchState([first, file]),
    pinnedSurfaceIds: [file.id],
    previewSurfaceId: first.id,
  };
  const closed = reduceWorkbench(state, {
    type: 'close-all-unpinned',
    entitlement: { kind: 'user', reason: 'bulk-close' },
  } as unknown as WorkbenchAction);
  expect(closed).toMatchObject({ surfaces: [file], previewSurfaceId: null, activeSurfaceId: file.id });
});
