import type { F284WorkspaceSnapshot, RestoreWorkbenchOptions, WorkbenchLayoutState } from './workbench-contract';
import { createInitialWorkbenchState } from './workbench-initial-state';
import { migrateF284WorkspaceState, restoreWorkbenchState } from './workbench-restore';

export const WORKBENCH_STORAGE_KEY = 'cat-cafe:workbench-layout-v2';
export const LEGACY_F307_WORKBENCH_STORAGE_KEY = 'cat-cafe:f307-phase-a-layout-v1';

export interface LoadedWorkbenchState {
  layout: WorkbenchLayoutState;
  source: 'current' | 'default' | 'f284' | 'phase-a';
}

interface LoadWorkbenchStateOptions extends RestoreWorkbenchOptions {
  storage: Storage;
  f284WorkspaceState?: F284WorkspaceSnapshot;
  defaultLayout?: WorkbenchLayoutState;
}

function parseStored(raw: string | null): unknown {
  if (raw === null) return undefined;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

export function writeWorkbenchState(storage: Storage, layout: WorkbenchLayoutState): void {
  storage.setItem(WORKBENCH_STORAGE_KEY, JSON.stringify({ ...layout, activity: [] }));
}

export function loadWorkbenchState(options: LoadWorkbenchStateOptions): LoadedWorkbenchState {
  const restoreOptions = { isOwnerRefAvailable: options.isOwnerRefAvailable };
  const current = parseStored(options.storage.getItem(WORKBENCH_STORAGE_KEY));
  if (current !== undefined) {
    return { layout: restoreWorkbenchState(current, restoreOptions), source: 'current' };
  }

  const phaseA = parseStored(options.storage.getItem(LEGACY_F307_WORKBENCH_STORAGE_KEY));
  if (phaseA !== undefined) {
    const layout = restoreWorkbenchState(phaseA, restoreOptions);
    writeWorkbenchState(options.storage, layout);
    return { layout, source: 'phase-a' };
  }

  if (options.f284WorkspaceState !== undefined) {
    const layout = migrateF284WorkspaceState(options.f284WorkspaceState);
    writeWorkbenchState(options.storage, layout);
    return { layout, source: 'f284' };
  }

  return { layout: options.defaultLayout ?? createInitialWorkbenchState(), source: 'default' };
}
