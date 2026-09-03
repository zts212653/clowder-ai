import { describe, expect, it } from 'vitest';

import type { WorkspaceSurfaceDescriptor } from '../workbench-contract';
import {
  createInitialWorkbenchState,
  migrateF284WorkspaceState,
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

function surface(id: string, type: WorkspaceSurfaceDescriptor['type'] = 'file'): WorkspaceSurfaceDescriptor {
  const rendererByType: Record<WorkspaceSurfaceDescriptor['type'], WorkspaceSurfaceDescriptor['renderer']> = {
    artifact: 'artifact-view',
    browser: 'browser-preview',
    code: 'code-editor',
    'evolution-program': 'evolution-program',
    file: 'file-preview',
    'agent-run': 'agent-run',
    review: 'review-summary',
    terminal: 'terminal-session',
    workspace: 'workspace-destination',
  };
  const objectKindByType: Record<WorkspaceSurfaceDescriptor['type'], WorkspaceSurfaceDescriptor['objectRef']['kind']> =
    {
      artifact: 'artifact',
      browser: 'preview-session',
      code: 'file',
      'evolution-program': 'evolution-program',
      file: 'file',
      'agent-run': 'agent-run',
      review: 'review',
      terminal: 'terminal-session',
      workspace: 'workspace-destination',
    };
  return {
    id,
    type,
    renderer: rendererByType[type],
    title: id,
    context: 'test owner',
    objectRef: { kind: objectKindByType[type], id: `object:${id}` },
    ownerStateRef: { owner: `owner:${type}`, key: `state:${id}` },
    capabilities: CAPABILITIES,
  };
}

const FILE = surface('file:brief');
const BROWSER = surface('browser:preview', 'browser');
const REVIEW = surface('review:ready', 'review');

const USER = { kind: 'user', reason: 'surface-tab' } as const;

describe('shared Workbench kernel', () => {
  it('owns add, active, reorder, and pin as generic topology', () => {
    let state = createInitialWorkbenchState([FILE]);
    state = reduceWorkbench(state, { type: 'open-surface', surface: BROWSER, entitlement: USER });
    state = reduceWorkbench(state, { type: 'open-surface', surface: REVIEW, entitlement: USER });
    state = reduceWorkbench(state, {
      type: 'reorder-surface',
      surfaceId: REVIEW.id,
      toIndex: 0,
      entitlement: USER,
    });
    state = reduceWorkbench(state, {
      type: 'pin-surface',
      surfaceId: BROWSER.id,
      pinned: true,
      entitlement: USER,
    });

    expect(state.surfaces.map((candidate) => candidate.id)).toEqual([REVIEW.id, FILE.id, BROWSER.id]);
    expect(state.activeSurfaceId).toBe(REVIEW.id);
    expect(state.pinnedSurfaceIds).toEqual([BROWSER.id]);
  });

  it('keeps sidecar identity outside the tab set and promotes it without copying owner state', () => {
    const initial = createInitialWorkbenchState([FILE, BROWSER]);
    const withSidecar = reduceWorkbench(initial, {
      type: 'open-sidecar',
      surface: REVIEW,
      entitlement: USER,
    });

    expect(withSidecar.sidecar).toEqual(REVIEW);
    expect(withSidecar.surfaces).not.toContainEqual(REVIEW);
    expect(withSidecar.activeSurfaceId).toBe(FILE.id);

    const promoted = reduceWorkbench(withSidecar, {
      type: 'promote-sidecar',
      destination: 'split',
      entitlement: { kind: 'user', reason: 'explicit-split' },
    });

    expect(promoted.sidecar).toBeNull();
    expect(promoted.surfaces.filter((candidate) => candidate.objectRef.id === REVIEW.objectRef.id)).toHaveLength(1);
    expect(promoted.split).toEqual({ primarySurfaceId: FILE.id, secondarySurfaceId: REVIEW.id });
  });

  it('detaches a sidecar into recent history and restores it as a user-owned tab', () => {
    const withSidecar = reduceWorkbench(createInitialWorkbenchState([FILE]), {
      type: 'open-sidecar',
      surface: REVIEW,
      entitlement: USER,
    });
    const closed = reduceWorkbench(withSidecar, {
      type: 'close-sidecar',
      entitlement: { kind: 'user', reason: 'close-button' },
    });

    expect(closed.sidecar).toBeNull();
    expect(closed.recentlyClosed).toEqual([REVIEW]);

    const restored = reduceWorkbench(closed, {
      type: 'restore-surface',
      surfaceId: REVIEW.id,
      entitlement: { kind: 'user', reason: 'recently-closed' },
    });
    expect(restored.surfaces).toEqual([FILE, REVIEW]);
    expect(restored.activeSurfaceId).toBe(REVIEW.id);
  });

  it('denies background focus and topology actions while preserving an explicit user split', () => {
    const split = reduceWorkbench(createInitialWorkbenchState([FILE, BROWSER]), {
      type: 'split-with',
      surfaceId: BROWSER.id,
      entitlement: { kind: 'user', reason: 'explicit-split' },
    });
    const background = { kind: 'background', reason: 'review-ready' } as const;

    const deniedActivation = reduceWorkbench(split, {
      type: 'activate-surface',
      surfaceId: BROWSER.id,
      entitlement: background,
    });
    const deniedOpen = reduceWorkbench(deniedActivation, {
      type: 'open-surface',
      surface: REVIEW,
      entitlement: background,
    });
    const deniedSidecar = reduceWorkbench(deniedOpen, {
      type: 'open-sidecar',
      surface: REVIEW,
      entitlement: background,
    });

    expect(deniedSidecar.activeSurfaceId).toBe(FILE.id);
    expect(deniedSidecar.surfaces).toEqual([FILE, BROWSER]);
    expect(deniedSidecar.split).toEqual(split.split);
    expect(deniedSidecar.sidecar).toBeNull();
    expect(deniedSidecar.activity).toEqual([expect.objectContaining({ surfaceId: REVIEW.id })]);
  });

  it('detaches a host, removes dangling topology, and restores only its descriptor', () => {
    let state = createInitialWorkbenchState([FILE, BROWSER]);
    state = reduceWorkbench(state, {
      type: 'pin-surface',
      surfaceId: BROWSER.id,
      pinned: true,
      entitlement: USER,
    });
    state = reduceWorkbench(state, {
      type: 'close-surface',
      surfaceId: BROWSER.id,
      entitlement: { kind: 'user', reason: 'close-button' },
    });

    expect(state.surfaces).toEqual([FILE]);
    expect(state.pinnedSurfaceIds).toEqual([]);
    expect(state.recentlyClosed).toEqual([BROWSER]);
    expect(state).not.toHaveProperty('ownerRecords');

    const restored = reduceWorkbench(state, {
      type: 'restore-surface',
      surfaceId: BROWSER.id,
      entitlement: { kind: 'user', reason: 'recently-closed' },
    });
    expect(restored.surfaces).toEqual([FILE, BROWSER]);
    expect(restored.activeSurfaceId).toBe(BROWSER.id);
  });

  it('restores schema v2 while filtering malformed and owner-dangling descriptors', () => {
    const restored = restoreWorkbenchState(
      {
        schemaVersion: 2,
        layoutOwner: 'f307',
        surfaces: [FILE, BROWSER, { ...REVIEW, renderer: 'unknown' }],
        pinnedSurfaceIds: [FILE.id, 'missing'],
        activeSurfaceId: BROWSER.id,
        split: { primarySurfaceId: FILE.id, secondarySurfaceId: 'missing' },
        sidecar: REVIEW,
        recentlyClosed: [],
        activity: [],
      },
      { isOwnerRefAvailable: (candidate) => candidate.id !== BROWSER.id },
    );

    expect(restored.surfaces).toEqual([FILE]);
    expect(restored.pinnedSurfaceIds).toEqual([FILE.id]);
    expect(restored.activeSurfaceId).toBe(FILE.id);
    expect(restored.split).toBeNull();
    expect(restored.sidecar).toEqual(REVIEW);
    expect(restored.activity).toContainEqual(expect.objectContaining({ kind: 'restore-warning' }));
  });

  it('migrates only the F284 whitelist and refuses the rejected F290 mode', () => {
    const migrated = migrateF284WorkspaceState({
      workspaceMode: 'dev',
      workspaceSurface: 'files',
      workspaceOpenFilePath: 'docs/features/F307-composable-workbench.md',
      workspaceWorktreeId: 'worktree-main',
      rightPanelOpen: false,
      collectiveWorkingSet: ['ignored-f290-state'],
    });

    expect(migrated.surfaces).toHaveLength(1);
    expect(migrated.surfaces[0]).toMatchObject({
      type: 'file',
      objectRef: { kind: 'file', id: 'worktree-main' },
      ownerStateRef: {
        owner: 'f063-workspace-file',
        key: 'worktree-main',
      },
      resultTargetRef: {
        owner: 'f063-workspace-file',
        key: 'worktree-main:docs/features/F307-composable-workbench.md',
      },
    });
    expect(migrated).not.toHaveProperty('collectiveWorkingSet');

    const rejected = migrateF284WorkspaceState({
      workspaceMode: 'collective',
      workspaceSurface: 'files',
      workspaceOpenFilePath: 'must-not-revive',
      collectiveWorkingSet: ['must-not-revive'],
    });
    expect(rejected.surfaces).toEqual([]);
    expect(rejected.activity).toContainEqual(expect.objectContaining({ id: 'migration:ignored-f290' }));
  });

  it('projects desktop and 390px from the same split, pin, order, and sidecar truth', () => {
    let state = createInitialWorkbenchState([FILE, BROWSER]);
    state = reduceWorkbench(state, {
      type: 'split-with',
      surfaceId: BROWSER.id,
      entitlement: { kind: 'user', reason: 'explicit-split' },
    });
    state = reduceWorkbench(state, { type: 'open-sidecar', surface: REVIEW, entitlement: USER });

    expect(projectWorkbench(state, 1024)).toMatchObject({
      kind: 'split',
      visibleSurfaceIds: [FILE.id, BROWSER.id],
      sidecarSurfaceId: REVIEW.id,
    });
    expect(projectWorkbench(state, 390)).toMatchObject({
      kind: 'stack',
      visibleSurfaceIds: [FILE.id],
      sidecarSurfaceId: REVIEW.id,
    });
    expect(state.split).not.toBeNull();
    expect(state.sidecar).toEqual(REVIEW);
  });
});
