import { describe, expect, it } from 'vitest';

import type { WorkspaceSurfaceDescriptor } from '../workbench-contract';
import {
  createInitialWorkbenchState,
  projectWorkbench,
  reduceWorkbench,
  restoreWorkbenchState,
} from '../workbench-model';

const CAPABILITIES: WorkspaceSurfaceDescriptor['capabilities'] = {
  split: true,
  sidecar: true,
  pin: true,
  closePolicy: 'detach-host',
  restorePolicy: 'descriptor',
};

function surface(id: string, type: 'file' | 'browser' | 'review'): WorkspaceSurfaceDescriptor {
  const renderer = type === 'browser' ? 'browser-preview' : type === 'review' ? 'review-summary' : 'file-preview';
  const kind = type === 'browser' ? 'preview-session' : type;
  return {
    id,
    type,
    renderer,
    title: id,
    context: 'real owner',
    objectRef: { kind, id: `object:${id}` },
    ownerStateRef: { owner: `owner:${type}`, key: `state:${id}` },
    capabilities: CAPABILITIES,
  };
}

const FILE = surface('file:brief', 'file');
const BROWSER = surface('browser:preview', 'browser');
const REVIEW = surface('review:ready', 'review');

describe('Workbench real-surface lifecycle', () => {
  it('refreshes descriptor metadata and exact result target without duplicating the owner object', () => {
    const refreshed = {
      ...FILE,
      title: 'src/App.tsx',
      context: 'worktree-main · src/App.tsx',
      resultTargetRef: { owner: 'f063-workspace-file', key: 'worktree-main:src/App.tsx' },
    } satisfies WorkspaceSurfaceDescriptor;
    const state = reduceWorkbench(createInitialWorkbenchState([FILE]), {
      type: 'open-surface',
      surface: refreshed,
      entitlement: { kind: 'user', reason: 'open-from-chat' },
    });

    expect(state.surfaces).toEqual([refreshed]);
    expect(state.activeSurfaceId).toBe(FILE.id);
  });

  it('retains a background descriptor for explicit reveal without stealing focus or changing split topology', () => {
    const split = reduceWorkbench(createInitialWorkbenchState([FILE, BROWSER]), {
      type: 'split-with',
      surfaceId: BROWSER.id,
      entitlement: { kind: 'user', reason: 'explicit-split' },
    });
    const background = reduceWorkbench(split, {
      type: 'open-surface',
      surface: REVIEW,
      entitlement: { kind: 'background', reason: 'review-ready' },
    });

    expect(background.activeSurfaceId).toBe(FILE.id);
    expect(background.split).toEqual(split.split);
    const activitySurface = background.activity[0]?.surface;
    expect(activitySurface).toEqual(REVIEW);
    if (!activitySurface) throw new Error('background activity must retain its validated descriptor');

    const revealed = reduceWorkbench(background, {
      type: 'open-surface',
      surface: activitySurface,
      entitlement: { kind: 'user', reason: 'surface-tab' },
    });
    expect(revealed.split).toEqual({ primarySurfaceId: REVIEW.id, secondarySurfaceId: BROWSER.id });
    expect(projectWorkbench(revealed, 1024).visibleSurfaceIds).toContain(REVIEW.id);
  });

  it('reveals a restored hidden surface in the current split slot', () => {
    const split = reduceWorkbench(createInitialWorkbenchState([FILE, BROWSER, REVIEW]), {
      type: 'split-with',
      surfaceId: BROWSER.id,
      entitlement: { kind: 'user', reason: 'explicit-split' },
    });
    const closed = reduceWorkbench(split, {
      type: 'close-surface',
      surfaceId: REVIEW.id,
      entitlement: { kind: 'user', reason: 'close-button' },
    });
    const restored = reduceWorkbench(closed, {
      type: 'restore-surface',
      surfaceId: REVIEW.id,
      entitlement: { kind: 'user', reason: 'recently-closed' },
    });

    expect(restored.split).toEqual({ primarySurfaceId: REVIEW.id, secondarySurfaceId: BROWSER.id });
    expect(projectWorkbench(restored, 1024).visibleSurfaceIds).toContain(REVIEW.id);
  });

  it('drops only a descriptor whose optional result target is malformed', () => {
    const valid = {
      ...FILE,
      resultTargetRef: { owner: 'f063-workspace-file', key: 'worktree-main:README.md' },
    } satisfies WorkspaceSurfaceDescriptor;
    const invalid = { ...BROWSER, resultTargetRef: { owner: '', key: 'preview:5173' } };
    const restored = restoreWorkbenchState({
      schemaVersion: 2,
      layoutOwner: 'f307',
      surfaces: [valid, invalid],
      pinnedSurfaceIds: [],
      activeSurfaceId: invalid.id,
      split: null,
      sidecar: null,
      recentlyClosed: [],
      activity: [],
    });

    expect(restored.surfaces).toEqual([valid]);
    expect(restored.activeSurfaceId).toBe(valid.id);
    expect(restored.activity).toContainEqual(expect.objectContaining({ kind: 'restore-warning' }));
  });
});
