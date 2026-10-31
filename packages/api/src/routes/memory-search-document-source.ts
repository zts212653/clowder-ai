import { realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { matchGlob } from '../domains/memory/CatCafeScanner.js';
import type { CollectionManifest, EvidenceItem } from '../domains/memory/interfaces.js';
import { resolveWorkspaceFilesystemPath } from '../domains/workspace/workspace-security.js';
import { isMemoryIndexPath } from './memory-search-types.js';

const contained = (root: string, path: string) => {
  const rel = relative(root, path);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
};
/** Reuse the workspace traversal/symlink/secret guard; nested libraries keep their own authority. */
export async function memoryDocumentPath(
  manifest: CollectionManifest,
  item: EvidenceItem,
  manifests: CollectionManifest[],
) {
  if (!item.sourcePath || isMemoryIndexPath(item.sourcePath) || /^(thread|session)$/.test(item.kind)) return null;
  const sourcePath = item.sourcePath;
  // Catalog ownership applies to stale index metadata too, even after a source disappears.
  assertDeclaredSourceBoundary(manifest, sourcePath, manifests);
  const root = await realpath(manifest.root);
  const path = await realpath(await resolveWorkspaceFilesystemPath(root, item.sourcePath));
  if (isMemoryIndexPath(relative(root, path))) throw new Error('Source belongs to the Taste reader');
  if (manifest.exclude?.some((pattern) => matchGlob(pattern, sourcePath) || matchGlob(pattern, relative(root, path))))
    throw new Error('Excluded source');
  for (const child of manifests) {
    if (child.id === manifest.id) continue;
    let childRoot: string;
    try {
      childRoot = await realpath(child.root);
    } catch {
      continue;
    }
    if (childRoot !== root && contained(root, childRoot) && contained(childRoot, path))
      throw new Error('Source belongs to another collection');
  }
  if (!(await stat(path)).isFile() || !/\.(?:md|mdx|txt|rst|adoc)$/i.test(path)) return null;
  return path;
}

function assertDeclaredSourceBoundary(
  manifest: CollectionManifest,
  sourcePath: string,
  manifests: CollectionManifest[],
) {
  const root = resolve(manifest.root);
  const path = resolve(root, sourcePath);
  if (!contained(root, path)) throw new Error('Source outside collection');
  if (manifest.exclude?.some((pattern) => matchGlob(pattern, sourcePath) || matchGlob(pattern, relative(root, path))))
    throw new Error('Excluded source');
  for (const child of manifests) {
    const childRoot = resolve(child.root);
    if (child.id !== manifest.id && childRoot !== root && contained(root, childRoot) && contained(childRoot, path))
      throw new Error('Source belongs to another collection');
  }
}
