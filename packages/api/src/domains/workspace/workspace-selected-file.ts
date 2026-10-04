import { realpath, stat } from 'node:fs/promises';
import { basename, isAbsolute, relative, resolve, sep } from 'node:path';
import type { RootConnectionSource } from './roots/workspace-linked-root-store.js';
import { canonicalLinkedRootId, readLinkedRootState } from './roots/workspace-linked-root-store.js';
import { issueRootConnectionProof } from './roots/workspace-root-proof.js';
import { createWorkspaceContentSource } from './workspace-content-source-factory.js';
import { readAuthorizedWorkspaceFileLocations } from './workspace-file-locations.js';
import { getWorktreeRoot, resolveWorkspaceFilesystemPath, WorkspaceSecurityError } from './workspace-security.js';

const contains = (root: string, path: string) =>
  path === root || path.startsWith(`${root}${root.endsWith(sep) ? '' : sep}`);

export class WorkspaceLocationInventoryUnavailable extends Error {
  constructor(readonly locations: Array<{ root: string; label: string }>) {
    super('Registered directory inventory is incomplete');
  }
}

function missingSelectedPath(error: NodeJS.ErrnoException): never {
  if (error.code === 'ENOENT' || error.code === 'ENOTDIR')
    throw new WorkspaceSecurityError('The selected file or directory no longer exists', 'NOT_FOUND');
  throw error;
}

/** The selected root is a visible location, not a grant. Only a separate human mutation connects it. */
export async function resolveSelectedWorkspaceFile(
  userId: string,
  selectedRoot: string,
  path: string,
  selectionEpoch?: number,
  connectionSource: RootConnectionSource = { kind: 'directory-selection' },
) {
  if (!isAbsolute(selectedRoot)) throw new WorkspaceSecurityError('Expected an absolute selected root', 'DENIED');
  const root = await realpath(selectedRoot).catch(missingSelectedPath);
  if (resolve(selectedRoot) !== root)
    throw new WorkspaceSecurityError('The selected location changed; choose it again', 'DENIED');
  const inventory = await readAuthorizedWorkspaceFileLocations();
  const ancestor = inventory.locations
    .filter((entry) => entry.status === 'available' && contains(entry.root, root))
    .sort((left, right) => right.root.length - left.root.length)[0];
  const intendedPath = resolve(root, path);
  if (!contains(root, intendedPath)) throw new WorkspaceSecurityError('File escapes the selected root', 'TRAVERSAL');
  const file = await resolveWorkspaceFilesystemPath(ancestor?.root ?? root, intendedPath);
  if (!(await stat(file).catch(missingSelectedPath)).isFile())
    throw new WorkspaceSecurityError('Expected a file', 'NOT_FOUND');
  if (!ancestor) {
    if (inventory.inventory !== 'available')
      throw new WorkspaceLocationInventoryUnavailable(
        inventory.locations.filter((entry) => entry.status === 'unavailable'),
      );
    const expectedEpoch = readLinkedRootState().rootEpochs[canonicalLinkedRootId(root)] ?? 0;
    if (selectionEpoch !== expectedEpoch)
      throw new WorkspaceSecurityError('The selected connection is no longer current', 'DENIED');
    return {
      kind: 'connection-required' as const,
      ownerUserId: userId,
      root,
      name: basename(root) || root,
      path: relative(root, file),
      absolutePath: await realpath(file),
      expectedEpoch,
      connectionProof: issueRootConnectionProof({ userId, root, expectedEpoch, source: connectionSource }),
    };
  }
  const locator = { worktreeId: canonicalLinkedRootId(ancestor.root), path: relative(ancestor.root, file) };
  const nativeRoot = await getWorktreeRoot(locator.worktreeId);
  if ((await realpath(resolve(nativeRoot, locator.path))) !== file)
    throw new WorkspaceSecurityError('File owner changed', 'DENIED');
  const source = await createWorkspaceContentSource(userId).describe({ principal: { userId }, locator });
  return { ...source.locator, kind: 'file' as const, absolutePath: await realpath(file) };
}
