import { afterEach, expect, it } from 'vitest';
import * as adapters from '../real-surface-adapters';
import {
  createInitialWorkbenchState,
  projectWorkbench,
  reduceWorkbench,
  restoreWorkbenchState,
} from '../workbench-model';
import { loadWorkbenchState, WORKBENCH_STORAGE_KEY, writeWorkbenchState } from '../workbench-persistence';

const preview = adapters.createFilePreviewSurface;
const root = 'listed-worktree';
const origin = { kind: 'chat-file-link', threadId: 'file-preview-thread', messageId: 'file-a' } as const;
const a = () => preview({ worktreeId: root, path: 'docs/A.md', navigationOrigin: origin });
const b = () => preview({ worktreeId: root, path: 'docs/B.md' });
const entitlement = { kind: 'user', reason: 'open-from-chat' } as const;

afterEach(() => localStorage.removeItem(WORKBENCH_STORAGE_KEY));

it('uses file object identity while keeping the listed F063 owner and line-independent presentation', () => {
  const first = a();
  const nextLine = preview({ worktreeId: root, path: 'docs/A.md', scrollToLine: 12 });
  expect(first.id).not.toBe(b().id);
  expect(first.objectRef).not.toEqual(b().objectRef);
  expect(nextLine.id).toBe(first.id);
  expect(nextLine.objectRef).toEqual(first.objectRef);
  expect(first.ownerStateRef).toEqual({ owner: adapters.REAL_SURFACE_OWNERS.file, key: root });
  expect(adapters.resolveFileTarget(nextLine)).toEqual({ worktreeId: root, path: 'docs/A.md', scrollToLine: 12 });
});

it('replaces A with B at the declared preview index, then keeps pinned A alongside preview B', () => {
  const first = a();
  const second = b();
  const state = { ...createInitialWorkbenchState([first]), previewSurfaceId: first.id };
  const replaced = reduceWorkbench(state, { type: 'open-preview-surface', surface: second, entitlement });
  expect(replaced.surfaces).toEqual([second]);
  const pinned = reduceWorkbench(state, { type: 'pin-surface', surfaceId: first.id, pinned: true, entitlement });
  const opened = reduceWorkbench(pinned, { type: 'open-preview-surface', surface: second, entitlement });
  expect(opened.surfaces).toEqual([first, second]);
  expect(opened).toMatchObject({ previewSurfaceId: second.id, activeSurfaceId: second.id });
  writeWorkbenchState(localStorage, opened);
  expect(
    loadWorkbenchState({ storage: localStorage, isOwnerRefAvailable: adapters.isRealSurfaceOwnerAvailable }).layout,
  ).toMatchObject({ surfaces: [first, second], pinnedSurfaceIds: [first.id], previewSurfaceId: second.id });
});

it.each(['tuple', 'legacy'])('updates a permanent %s file in place with the new line and return origin', (kind) => {
  const first = kind === 'legacy' ? adapters.createFileSurface({ worktreeId: root, path: 'docs/A.md' }) : a();
  const second = b();
  const state = {
    ...createInitialWorkbenchState([first, second]),
    pinnedSurfaceIds: [first.id],
    previewSurfaceId: second.id,
  };
  const request = preview({
    worktreeId: root,
    path: 'docs/A.md',
    scrollToLine: 37,
    navigationOrigin: { ...origin, messageId: 'new-origin' },
  });
  const opened = reduceWorkbench(state, { type: 'open-preview-surface', surface: request, entitlement });
  expect(opened.surfaces).toHaveLength(2);
  expect(opened.surfaces[0]?.id).toBe(first.id);
  expect(opened.activeSurfaceId).toBe(first.id);
  expect(opened.previewSurfaceId).toBe(second.id);
  expect(opened.surfaces[1]).toEqual(second);
  expect(adapters.resolveFileTarget(opened.surfaces[0])).toEqual({
    worktreeId: root,
    path: 'docs/A.md',
    scrollToLine: 37,
  });
  expect(opened.surfaces[0]?.navigationOrigin).toEqual(request.navigationOrigin);
});

it.each(
  [[root, 'docs/A.md'], [root], ['another-worktree', 'docs/A.md'], [root, 'docs/B.md'], [root, 'docs/A.md', 12]].map(
    (tuple) => [tuple],
  ),
)('admits only the exact two-field object tuple: %j', (tuple) => {
  const file = adapters.createFileSurface({ worktreeId: root, path: 'docs/A.md' });
  const surface = {
    ...file,
    id: 'file-preview:test',
    objectRef: { kind: 'file' as const, id: encodeURIComponent(JSON.stringify(tuple)) },
  };
  const valid = tuple.length === 2 && tuple[0] === root && tuple[1] === 'docs/A.md';
  expect(adapters.resolveFileTarget(surface)).toEqual(
    valid ? { worktreeId: root, path: 'docs/A.md', scrollToLine: null } : null,
  );
  expect(restoreWorkbenchState(createInitialWorkbenchState([surface])).surfaces).toHaveLength(valid ? 1 : 0);
});

it('keeps classic root identity and its persisted descriptor unchanged', () => {
  const file = adapters.createFileSurface({ worktreeId: root, path: 'docs/A.md' });
  expect(file.id).toBe(`file-owner:${root}`);
  expect(file.objectRef).toEqual({ kind: 'file', id: root });
  expect(restoreWorkbenchState(createInitialWorkbenchState([file])).surfaces).toEqual([file]);
});

it('actually displays a permanent file opened outside the current split, without consuming another preview', () => {
  const first = a();
  const previewFile = preview({ worktreeId: 'other-root', path: 'B.md' });
  const left = adapters.createBrowserSurface({ ownerKey: 'left', port: 5324 });
  const right = adapters.createBrowserSurface({ ownerKey: 'right', port: 5324 });
  const state = {
    ...createInitialWorkbenchState([first, previewFile, left, right]),
    previewSurfaceId: previewFile.id,
    activeSurfaceId: left.id,
    split: { primarySurfaceId: left.id, secondarySurfaceId: right.id },
  };
  const opened = reduceWorkbench(state, { type: 'open-preview-surface', surface: first, entitlement });
  expect(projectWorkbench(opened, 1024).visibleSurfaceIds).toEqual([first.id, right.id]);
  expect(opened.previewSurfaceId).toBe(previewFile.id);
});
