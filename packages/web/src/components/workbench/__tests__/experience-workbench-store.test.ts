import { describe, expect, it } from 'vitest';

import {
  createInitialWorkbenchState,
  migrateF284WorkspaceState,
  projectWorkbench,
  reduceWorkbench,
  restoreWorkbenchState,
} from '@/components/workbench/workbench-model';
import { createArtifactSurface, createBrowserSurface, createFileSurface } from '../real-surface-adapters';

const FILE_SURFACE = createFileSurface({
  worktreeId: 'worktree-main',
  path: 'docs/features/F307-composable-workbench.md',
});
const BROWSER_SURFACE = createBrowserSurface({ ownerKey: 'worktree-main', port: 4173, path: '/' });
const REVIEW_SURFACE = createArtifactSurface({
  threadId: 'thread-f307',
  artifact: {
    type: 'pr',
    name: 'F307 review',
    catId: 'codex-terra',
    createdAt: 1787880000000,
    sourceMessageId: 'message-review',
    ref: 'zts212653/cat-cafe#4030',
  },
});

describe('F307 experience adapter on the shared Workbench kernel', () => {
  it('keeps a second surface in the stack until the user explicitly splits it', () => {
    const initial = createInitialWorkbenchState([FILE_SURFACE]);
    const withBrowser = reduceWorkbench(initial, {
      type: 'open-surface',
      surface: BROWSER_SURFACE,
      entitlement: { kind: 'user', reason: 'open-from-chat' },
    });

    expect(withBrowser.activeSurfaceId).toBe(BROWSER_SURFACE.id);
    expect(withBrowser.split).toBeNull();
    expect(withBrowser.surfaces.map((surface) => surface.id)).toEqual([FILE_SURFACE.id, BROWSER_SURFACE.id]);

    const split = reduceWorkbench(withBrowser, {
      type: 'split-with',
      surfaceId: FILE_SURFACE.id,
      entitlement: { kind: 'user', reason: 'explicit-split' },
    });

    expect(split.split).toEqual({
      primarySurfaceId: BROWSER_SURFACE.id,
      secondarySurfaceId: FILE_SURFACE.id,
    });
  });

  it('records a background event without taking focus or rewriting the split', () => {
    const split = reduceWorkbench(
      reduceWorkbench(createInitialWorkbenchState([FILE_SURFACE]), {
        type: 'open-surface',
        surface: BROWSER_SURFACE,
        entitlement: { kind: 'user', reason: 'open-from-chat' },
      }),
      {
        type: 'split-with',
        surfaceId: FILE_SURFACE.id,
        entitlement: { kind: 'user', reason: 'explicit-split' },
      },
    );

    const afterBackgroundEvent = reduceWorkbench(split, {
      type: 'open-surface',
      surface: REVIEW_SURFACE,
      entitlement: { kind: 'background', reason: 'review-ready' },
    });

    expect(afterBackgroundEvent.activeSurfaceId).toBe(BROWSER_SURFACE.id);
    expect(afterBackgroundEvent.split).toEqual(split.split);
    expect(afterBackgroundEvent.activity).toEqual([
      expect.objectContaining({ surfaceId: REVIEW_SURFACE.id, kind: 'review-ready' }),
    ]);

    const afterClosingFocusedSurface = reduceWorkbench(afterBackgroundEvent, {
      type: 'close-surface',
      surfaceId: BROWSER_SURFACE.id,
      entitlement: { kind: 'user', reason: 'close-button' },
    });
    expect(afterClosingFocusedSurface.activeSurfaceId).toBe(FILE_SURFACE.id);
  });

  it('closes only the host and can restore the same owner-backed descriptor', () => {
    const withBrowser = reduceWorkbench(createInitialWorkbenchState([FILE_SURFACE]), {
      type: 'open-surface',
      surface: BROWSER_SURFACE,
      entitlement: { kind: 'user', reason: 'open-from-chat' },
    });
    const closed = reduceWorkbench(withBrowser, {
      type: 'close-surface',
      surfaceId: BROWSER_SURFACE.id,
      entitlement: { kind: 'user', reason: 'close-button' },
    });

    expect(closed.surfaces).not.toContainEqual(BROWSER_SURFACE);
    expect(closed.recentlyClosed[0]).toEqual(BROWSER_SURFACE);

    const restored = reduceWorkbench(closed, {
      type: 'restore-surface',
      surfaceId: BROWSER_SURFACE.id,
      entitlement: { kind: 'user', reason: 'recently-closed' },
    });
    expect(restored.activeSurfaceId).toBe(BROWSER_SURFACE.id);
    expect(restored.surfaces).toContainEqual(BROWSER_SURFACE);
    expect(restored.recentlyClosed).toEqual([]);
  });

  it('projects a split into one narrow viewport without changing layout truth', () => {
    const split = reduceWorkbench(
      reduceWorkbench(createInitialWorkbenchState([FILE_SURFACE]), {
        type: 'open-surface',
        surface: BROWSER_SURFACE,
        entitlement: { kind: 'user', reason: 'open-from-chat' },
      }),
      {
        type: 'split-with',
        surfaceId: FILE_SURFACE.id,
        entitlement: { kind: 'user', reason: 'explicit-split' },
      },
    );

    expect(projectWorkbench(split, 390)).toEqual({
      kind: 'stack',
      visibleSurfaceIds: [BROWSER_SURFACE.id],
      sidecarSurfaceId: null,
    });
    expect(projectWorkbench(split, 1024)).toEqual({
      kind: 'split',
      visibleSurfaceIds: [BROWSER_SURFACE.id, FILE_SURFACE.id],
      sidecarSurfaceId: null,
    });
    expect(split.split).not.toBeNull();
  });

  it('restores valid descriptors and drops malformed or dangling references', () => {
    const restored = restoreWorkbenchState({
      schemaVersion: 1,
      layoutOwner: 'f307',
      surfaces: [FILE_SURFACE, { ...BROWSER_SURFACE, renderer: 'unknown-renderer' }],
      activeSurfaceId: 'missing',
      split: {
        primarySurfaceId: FILE_SURFACE.id,
        secondarySurfaceId: 'missing',
      },
      recentlyClosed: [],
      activity: [],
    });

    expect(restored.surfaces).toEqual([FILE_SURFACE]);
    expect(restored.activeSurfaceId).toBe(FILE_SURFACE.id);
    expect(restored.split).toBeNull();
    expect(restored.activity).toContainEqual(expect.objectContaining({ kind: 'restore-warning' }));
  });

  it('migrates the one-surface F284 snapshot without reviving F290 state', () => {
    const migrated = migrateF284WorkspaceState({
      workspaceMode: 'dev',
      workspaceSurface: 'files',
      workspaceOpenFilePath: 'docs/features/F307-composable-workbench.md',
      workspaceWorktreeId: 'worktree-main',
      rightPanelOpen: false,
      collectiveWorkingSet: ['must-not-migrate'],
    });

    expect(migrated.layoutOwner).toBe('f307');
    expect(migrated.surfaces).toHaveLength(1);
    expect(migrated.surfaces[0]).toEqual(
      expect.objectContaining({
        type: 'file',
        objectRef: expect.objectContaining({
          id: 'worktree-main',
        }),
        ownerStateRef: {
          owner: 'f063-workspace-file',
          key: 'worktree-main',
        },
        resultTargetRef: {
          owner: 'f063-workspace-file',
          key: 'worktree-main:docs/features/F307-composable-workbench.md',
        },
      }),
    );
    expect(migrated).not.toHaveProperty('collectiveWorkingSet');
  });

  it('round-trips the persisted split layout through JSON', () => {
    const split = reduceWorkbench(
      reduceWorkbench(createInitialWorkbenchState([FILE_SURFACE]), {
        type: 'open-surface',
        surface: BROWSER_SURFACE,
        entitlement: { kind: 'user', reason: 'open-from-chat' },
      }),
      {
        type: 'split-with',
        surfaceId: FILE_SURFACE.id,
        entitlement: { kind: 'user', reason: 'explicit-split' },
      },
    );
    expect(restoreWorkbenchState(JSON.parse(JSON.stringify(split)))).toEqual(split);
  });

  it('refreshes an owner result target without taking focus or changing topology', () => {
    const split = reduceWorkbench(
      reduceWorkbench(createInitialWorkbenchState([FILE_SURFACE]), {
        type: 'open-surface',
        surface: BROWSER_SURFACE,
        entitlement: { kind: 'user', reason: 'open-from-chat' },
      }),
      {
        type: 'split-with',
        surfaceId: FILE_SURFACE.id,
        entitlement: { kind: 'user', reason: 'explicit-split' },
      },
    );
    const navigated = createBrowserSurface({ ownerKey: 'worktree-main', port: 4173, path: '/settings' });

    const refreshed = reduceWorkbench(split, { type: 'refresh-surface', surface: navigated });

    expect(refreshed.activeSurfaceId).toBe(split.activeSurfaceId);
    expect(refreshed.split).toEqual(split.split);
    expect(refreshed.surfaces.find((surface) => surface.id === navigated.id)?.resultTargetRef).toEqual(
      navigated.resultTargetRef,
    );
  });
});
