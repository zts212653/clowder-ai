import { dirname } from 'node:path';
import { durableIdForCanonicalRoot } from '../workspace-worktree-identity.js';
import type { LinkedRootState } from './workspace-linked-root-store.js';

/** A path-only entrance cannot turn removal into a suggestion to connect a smaller directory. */
export function removedWorkspaceAncestor(state: LinkedRootState, root: string): string | null {
  let candidate = root;
  for (;;) {
    const id = durableIdForCanonicalRoot(candidate);
    if ((state.rootEpochs[id] ?? 0) > 0 && !state.roots.some((entry) => entry.id === id)) return candidate;
    const parent = dirname(candidate);
    if (parent === candidate) return null;
    candidate = parent;
  }
}
