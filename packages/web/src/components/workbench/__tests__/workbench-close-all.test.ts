import { afterEach, expect, it } from 'vitest';
import { createArtifactReviewSurface } from '../artifact-review-surface';
import { useF307ExperienceWorkbenchStore } from '../experience-workbench-store';
import {
  createBrowserSurface,
  createFileSurface,
  createProductScheduleReturnSurface,
  createWorkspaceModeSurface,
} from '../real-surface-adapters';
import type { WorkbenchAction, WorkbenchLayoutState } from '../workbench-contract';
import { createInitialWorkbenchState, reduceWorkbench } from '../workbench-model';
import { loadWorkbenchState, WORKBENCH_STORAGE_KEY } from '../workbench-persistence';

const file = createFileSurface({ worktreeId: 'bulk-close', path: 'guide.md' });
const browser = createBrowserSurface({ ownerKey: 'bulk-close', port: 5323, path: '/owner' });
const returnSurface = createProductScheduleReturnSurface(
  createWorkspaceModeSurface('product-schedule', 'thread-bulk'),
  'task-bulk',
);
if (!returnSurface) throw new Error('the original entrusted-work return adapter must resolve');
const review = {
  ...createArtifactReviewSurface(`review-${'b'.repeat(64)}`, 'thread-bulk', 'Review'),
  returnTargetRef: returnSurface.resultTargetRef,
};
const user = { kind: 'user', reason: 'bulk-close' } as const;
// The runtime regression precedes adding this command to the discriminated contract.
const closeAll = { type: 'close-all-unpinned', entitlement: user } as unknown as WorkbenchAction;

afterEach(() => {
  localStorage.removeItem(WORKBENCH_STORAGE_KEY);
  useF307ExperienceWorkbenchStore.setState({
    layout: createInitialWorkbenchState(),
    hydrated: false,
    mainAreaAttentionSurfaceId: null,
    focusSurfaceId: null,
  });
});

it('atomically removes unpinned tabs without following Artifact return edges into new tabs', () => {
  const state = {
    ...createInitialWorkbenchState([file, browser, review]),
    activeSurfaceId: review.id,
    pinnedSurfaceIds: [file.id],
    sidecar: returnSurface,
    split: { primarySurfaceId: file.id, secondarySurfaceId: review.id },
  };
  const closed = reduceWorkbench(state, closeAll);
  expect(closed.surfaces).toEqual([file]);
  expect(closed.activeSurfaceId).toBe(file.id);
  expect(closed.pinnedSurfaceIds).toEqual([file.id]);
  expect(closed.sidecar).toBe(returnSurface);
  expect(closed.split).toBeNull();
  expect(closed.recentlyClosed).toEqual([browser, review]);
  expect(closed).not.toHaveProperty('ownerRecords');
  // A single close deliberately keeps its old, different exact-return behavior.
  const single = reduceWorkbench(state, { type: 'close-surface', surfaceId: review.id, entitlement: user });
  expect(single.activeSurfaceId).toBe(returnSurface.id);
  expect(single.surfaces).toContainEqual(returnSurface);
});

it('keeps a pinned active owner and split only when both split owners are pinned', () => {
  const state = {
    ...createInitialWorkbenchState([file, browser, review]),
    activeSurfaceId: file.id,
    pinnedSurfaceIds: [file.id, browser.id],
    split: { primarySurfaceId: file.id, secondarySurfaceId: browser.id },
  };
  const closed = reduceWorkbench(state, closeAll);
  expect(closed.surfaces).toEqual([file, browser]);
  expect(closed.activeSurfaceId).toBe(file.id);
  expect(closed.split).toBe(state.split);
  expect(closed.recentlyClosed).toEqual([review]);
  expect(reduceWorkbench(closed, closeAll)).toBe(closed);
});

it('leaves zero tab topology and records each detached descriptor once when no tab is pinned', () => {
  const state: WorkbenchLayoutState = {
    ...createInitialWorkbenchState([file, browser, review]),
    recentlyClosed: [{ ...browser, id: 'old-browser-alias' }],
  };
  const closed = reduceWorkbench(state, closeAll);
  expect(closed.surfaces).toEqual([]);
  expect(closed.activeSurfaceId).toBeNull();
  expect(closed.pinnedSurfaceIds).toEqual([]);
  expect(closed.recentlyClosed).toEqual([file, browser, review]);
});

it('does not give a background arrival authority to detach user tabs', () => {
  const state = createInitialWorkbenchState([file, browser]);
  expect(
    reduceWorkbench(state, {
      ...closeAll,
      entitlement: { kind: 'background', reason: 'owner-background' },
    } as WorkbenchAction),
  ).toBe(state);
});

it('clears detached focus and attention through the existing store and persists only retained tabs', () => {
  const state = {
    ...createInitialWorkbenchState([file, browser, review]),
    activeSurfaceId: browser.id,
    pinnedSurfaceIds: [file.id],
  };
  useF307ExperienceWorkbenchStore.setState({
    layout: state,
    hydrated: true,
    mainAreaAttentionSurfaceId: browser.id,
    focusSurfaceId: browser.id,
  });
  useF307ExperienceWorkbenchStore.getState().dispatch(closeAll);
  const closed = useF307ExperienceWorkbenchStore.getState();
  expect(closed.layout.surfaces).toEqual([file]);
  expect(closed.mainAreaAttentionSurfaceId).toBeNull();
  expect(closed.focusSurfaceId).toBeNull();
  const reloaded = loadWorkbenchState({ storage: localStorage }).layout;
  expect(reloaded.surfaces).toEqual([file]);
  expect(reloaded.pinnedSurfaceIds).toEqual([file.id]);
  expect(reloaded.recentlyClosed).toEqual([browser, review]);
});
