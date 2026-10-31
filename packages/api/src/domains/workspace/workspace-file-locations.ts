import { basename, resolve, sep } from 'node:path';
import { canonicalLinkedRootId, readLinkedRootState } from './roots/workspace-linked-root-store.js';
import {
  getLinkedRootsAsync,
  listWorkspaceRootEntries,
  listWorktrees,
  type WorktreeEntry,
} from './workspace-security.js';
import { canonicalWorkspaceIdentityRoot } from './workspace-worktree-identity.js';

interface FileLocation {
  root: string;
  label: string;
  branch: string;
  status: 'available' | 'unavailable';
}

/** Canonical identity deduplicates aliases; failed entries remain visible, never a uniqueness proof. */
async function projectLocations(entries: readonly WorktreeEntry[]) {
  const locations = new Map<string, FileLocation>();
  let partial = entries.some((entry) => entry.head === 'nogit');
  for (const entry of entries) {
    let root: string;
    let status: FileLocation['status'] = 'available';
    try {
      const currentRoot = await canonicalWorkspaceIdentityRoot(entry);
      if (!currentRoot) throw new Error('Workspace root is unavailable or changed');
      root = currentRoot;
    } catch {
      root = resolve(entry.root);
      status = 'unavailable';
      partial = true;
    }
    const key = `${status}:${root}`;
    const existing = locations.get(key);
    if (existing) {
      if (!existing.branch.split(' / ').includes(entry.branch)) existing.branch += ` / ${entry.branch}`;
    } else locations.set(key, { root, label: basename(root), branch: entry.branch, status });
  }
  return { locations: [...locations.values()], inventory: partial ? ('partial' as const) : ('available' as const) };
}

export async function readAuthorizedWorkspaceFileLocations() {
  const [primary, linked] = await Promise.all([
    listWorktrees(process.env.CAT_CAFE_WORKSPACE_ROOT?.trim() || undefined),
    getLinkedRootsAsync(),
  ]);
  return projectLocations([...primary, ...linked]);
}

export async function readWorkspaceFileLocations() {
  const [candidates, authority] = await Promise.all([
    projectLocations(await listWorkspaceRootEntries()),
    readAuthorizedWorkspaceFileLocations(),
  ]);
  const state = readLinkedRootState();
  return {
    ...candidates,
    locations: candidates.locations.map((location) => {
      const connected = authority.locations.some(
        (entry) =>
          entry.status === 'available' &&
          (location.root === entry.root ||
            location.root.startsWith(`${entry.root}${entry.root.endsWith(sep) ? '' : sep}`)),
      );
      const connection = connected
        ? 'connected'
        : authority.inventory === 'available' && location.status === 'available'
          ? 'required'
          : 'unknown';
      return { ...location, connection, expectedEpoch: state.rootEpochs[canonicalLinkedRootId(location.root)] ?? 0 };
    }),
  };
}
