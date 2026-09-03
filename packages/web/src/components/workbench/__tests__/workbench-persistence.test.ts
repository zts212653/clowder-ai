import { describe, expect, it } from 'vitest';
import { resolveFileTarget } from '../real-surface-adapters';
import type { WorkbenchLayoutState } from '../workbench-contract';
import { createInitialWorkbenchState } from '../workbench-model';
import {
  LEGACY_F307_WORKBENCH_STORAGE_KEY,
  loadWorkbenchState,
  WORKBENCH_STORAGE_KEY,
  writeWorkbenchState,
} from '../workbench-persistence';

class MemoryStorage implements Storage {
  readonly reads: string[] = [];
  readonly writes: string[] = [];
  private readonly values = new Map<string, string>();

  get length(): number {
    return this.values.size;
  }

  clear(): void {
    this.values.clear();
  }

  getItem(key: string): string | null {
    this.reads.push(key);
    return this.values.get(key) ?? null;
  }

  key(index: number): string | null {
    return [...this.values.keys()][index] ?? null;
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }

  setItem(key: string, value: string): void {
    this.writes.push(key);
    this.values.set(key, value);
  }
}

function phaseALayout(): Omit<WorkbenchLayoutState, 'schemaVersion' | 'pinnedSurfaceIds' | 'sidecar'> & {
  schemaVersion: 1;
} {
  const current = createInitialWorkbenchState();
  return {
    schemaVersion: 1,
    layoutOwner: current.layoutOwner,
    surfaces: current.surfaces,
    activeSurfaceId: current.activeSurfaceId,
    split: current.split,
    recentlyClosed: current.recentlyClosed,
    activity: current.activity,
  };
}

describe('Workbench persistence boundary', () => {
  it('upgrades the Phase A key into the shared v2 key', () => {
    const storage = new MemoryStorage();
    storage.setItem(LEGACY_F307_WORKBENCH_STORAGE_KEY, JSON.stringify(phaseALayout()));

    const loaded = loadWorkbenchState({ storage });

    expect(loaded.source).toBe('phase-a');
    expect(loaded.layout.schemaVersion).toBe(2);
    expect(storage.writes).toContain(WORKBENCH_STORAGE_KEY);
  });

  it('reads no rejected F290 key and falls back to the F284 whitelist', () => {
    const storage = new MemoryStorage();
    const rejectedF290Key = ['cat-cafe', 'f290-composable-workspace'].join(':');
    storage.setItem(rejectedF290Key, JSON.stringify({ tabs: ['must-not-revive'] }));

    const loaded = loadWorkbenchState({
      storage,
      f284WorkspaceState: {
        workspaceMode: 'dev',
        workspaceSurface: 'browser',
        workspacePreview: { port: 3102, path: '/thread/f307' },
      },
    });

    expect(loaded.source).toBe('f284');
    expect(loaded.layout.surfaces[0]).toMatchObject({ type: 'browser' });
    expect(storage.reads).toEqual([WORKBENCH_STORAGE_KEY, LEGACY_F307_WORKBENCH_STORAGE_KEY]);
    expect(storage.reads.some((key) => key.includes('f290'))).toBe(false);
  });

  it('preserves a validated content-search line through F284 recovery and canonical persistence', () => {
    const storage = new MemoryStorage();

    const recovered = loadWorkbenchState({
      storage,
      f284WorkspaceState: {
        workspaceMode: 'dev',
        workspaceSurface: 'files',
        workspaceOpenFilePath: 'src/F307-search-result.ts',
        workspaceOpenFileLine: 120,
        workspaceWorktreeId: 'worktree-a',
      },
    });

    expect(recovered.source).toBe('f284');
    expect(resolveFileTarget(recovered.layout.surfaces[0])).toEqual({
      worktreeId: 'worktree-a',
      path: 'src/F307-search-result.ts',
      scrollToLine: 120,
    });

    const restored = loadWorkbenchState({ storage });
    expect(restored.source).toBe('current');
    expect(resolveFileTarget(restored.layout.surfaces[0])).toEqual({
      worktreeId: 'worktree-a',
      path: 'src/F307-search-result.ts',
      scrollToLine: 120,
    });
  });

  it.each([0, '120', 1.5])('normalizes malformed F284 file line %j to null', (workspaceOpenFileLine) => {
    const storage = new MemoryStorage();
    const recovered = loadWorkbenchState({
      storage,
      f284WorkspaceState: {
        workspaceMode: 'dev',
        workspaceSurface: 'files',
        workspaceOpenFilePath: 'src/F307-search-result.ts',
        workspaceOpenFileLine,
        workspaceWorktreeId: 'worktree-a',
      },
    });

    expect(resolveFileTarget(recovered.layout.surfaces[0])?.scrollToLine).toBeNull();
  });

  it('fails closed when the current payload is malformed', () => {
    const storage = new MemoryStorage();
    storage.setItem(WORKBENCH_STORAGE_KEY, '{broken-json');

    const loaded = loadWorkbenchState({ storage });

    expect(loaded.source).toBe('current');
    expect(loaded.layout.surfaces).toEqual([]);
    expect(loaded.layout.activity).toContainEqual(expect.objectContaining({ kind: 'restore-warning' }));
  });

  it('writes only the shared layout truth', () => {
    const storage = new MemoryStorage();
    const layout: WorkbenchLayoutState = {
      ...createInitialWorkbenchState(),
      activity: [{ id: 'surface-ready:stale', kind: 'surface-ready', message: 'Transient activity' }],
    };

    writeWorkbenchState(storage, layout);

    expect(storage.writes).toEqual([WORKBENCH_STORAGE_KEY]);
    expect(JSON.parse(storage.getItem(WORKBENCH_STORAGE_KEY) ?? 'null')).toEqual({ ...layout, activity: [] });
  });

  it('does not restore transient activity written by an older client', () => {
    const storage = new MemoryStorage();
    storage.setItem(
      WORKBENCH_STORAGE_KEY,
      JSON.stringify({
        ...createInitialWorkbenchState(),
        activity: [{ id: 'surface-ready:stale', kind: 'surface-ready', message: 'Transient activity' }],
      }),
    );

    const loaded = loadWorkbenchState({ storage });

    expect(loaded.layout.activity).toEqual([]);
  });
});
