import { realpathSync } from 'node:fs';
import type { CollectionManifest } from '../domains/memory/collection-types.js';

interface ReadCollection {
  id: string;
  status: string;
  readStatus: string;
}
function canonicalRoot(root: string | undefined): string | null {
  if (!root) return null;
  try {
    return realpathSync(root);
  } catch {
    return null;
  }
}

/** Reveal the existing MaterializationService docsRoot default without exporting filesystem paths. */
export function defaultMemoryLibraryTarget(
  collections: readonly ReadCollection[],
  manifests: readonly CollectionManifest[],
  docsRoot: string | undefined,
): string | null {
  const root = canonicalRoot(docsRoot);
  if (!root) return null;
  const roots = new Map(manifests.map((manifest) => [manifest.id, manifest.root]));
  const matches = collections.filter(
    (collection) =>
      collection.readStatus === 'ready' &&
      collection.status !== 'archived' &&
      canonicalRoot(roots.get(collection.id)) === root,
  );
  return matches.length === 1 ? matches[0].id : null;
}
