import { StaticTreeIdentity } from './static-tree-identity.js';

type TreeIdentity = ReadonlyMap<string, string>;

function equal(left: TreeIdentity, right: TreeIdentity): boolean {
  return left.size === right.size && [...left].every(([path, stamp]) => right.get(path) === stamp);
}

/** A private, per-staging-generation proof for static assets already copied into
 * Host-owned Buffers. Never used to admit executable files from disk. The byte
 * proof is bracketed by stable tree identities; every use rechecks that exact
 * identity. No time-based cache, re-sealing after mutation, or authority grant. */
export async function sealStaticPackage(root: string, verifyBytes: () => Promise<void>): Promise<() => Promise<void>> {
  let damaged = false;
  const tree = new StaticTreeIdentity(() => {
    damaged = true;
  });
  const before = await tree.snapshot(root);
  await verifyBytes();
  const admitted = await tree.snapshot(root);
  if (!equal(before, admitted)) throw new Error('static package changed while sealing');
  return async () => {
    if (damaged) throw new Error('static package generation is damaged');
    try {
      if (!equal(admitted, await tree.snapshot(root))) throw new Error('static package generation changed');
      if (damaged) throw new Error('static package generation is damaged');
    } catch (error) {
      damaged = true;
      throw error;
    }
  };
}
