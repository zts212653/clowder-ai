/**
 * F129: Load + compile active packs for invocation injection.
 * Called from routing (serial/parallel) before buildStaticIdentity.
 *
 * Phase A: single-pack (first installed wins). Multi-pack merge is Phase B.
 */

import type { CompiledPackBlocks } from '@cat-cafe/shared';
import { PackCompiler } from './PackCompiler.js';
import type { PackStore } from './PackStore.js';

const compiler = new PackCompiler();

/**
 * Load first active pack, compile it, return blocks.
 * Returns null if no packs installed or compilation fails.
 */
export async function getActivePackBlocks(store: PackStore): Promise<CompiledPackBlocks | null> {
  try {
    const manifests = await store.list();
    if (manifests.length === 0) return null;

    // Phase A: use first installed pack
    const pack = await store.get(manifests[0].name);
    if (!pack) return null;

    return await compiler.compile(pack);
  } catch {
    // Best-effort: pack compilation failure does not block invocation
    return null;
  }
}
