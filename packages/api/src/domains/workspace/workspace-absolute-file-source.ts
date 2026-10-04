import { realpath, stat } from 'node:fs/promises';
import { basename, dirname, resolve, sep } from 'node:path';
import { readLinkedRootState } from './roots/workspace-linked-root-store.js';
import { removedWorkspaceAncestor } from './roots/workspace-root-history.js';
import { readAuthorizedWorkspaceFileLocations } from './workspace-file-locations.js';
import { assertWorkspacePathAllowed, WorkspaceSecurityError } from './workspace-security.js';
import { resolveSelectedWorkspaceFile, WorkspaceLocationInventoryUnavailable } from './workspace-selected-file.js';

const contains = (root: string, path: string) =>
  path === root || path.startsWith(`${root}${root.endsWith(sep) ? '' : sep}`);

/** Only suggests the current containing directory. Existing owners keep their original resolution path. */
export async function prepareAbsoluteFileDirectory(userId: string, path: string) {
  const absolute = resolve(path);
  const inventory = await readAuthorizedWorkspaceFileLocations();
  if (inventory.locations.some((entry) => contains(entry.root, absolute))) return null;
  const physical = await realpath(absolute).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR')
      throw new WorkspaceSecurityError('Original file no longer exists', 'NOT_FOUND');
    throw error;
  });
  if (inventory.locations.some((entry) => contains(entry.root, physical))) return null;
  if (physical !== absolute)
    throw new WorkspaceSecurityError('Unregistered original path traverses a symlink', 'DENIED');
  assertWorkspacePathAllowed(physical);
  if (!(await stat(physical)).isFile()) throw new WorkspaceSecurityError('Expected an original file', 'NOT_FOUND');
  const root = dirname(physical);
  if (removedWorkspaceAncestor(readLinkedRootState(), root))
    throw new WorkspaceSecurityError('The original containing directory was disconnected', 'DENIED');
  if (inventory.inventory !== 'available')
    throw new WorkspaceLocationInventoryUnavailable(
      inventory.locations.filter((entry) => entry.status === 'unavailable'),
    );
  const selected = await resolveSelectedWorkspaceFile(userId, root, basename(physical), 0, {
    kind: 'absolute-file',
    path: physical,
  });
  return selected.kind === 'connection-required'
    ? { ...selected, admission: 'absolute-file-directory' as const }
    : selected;
}
