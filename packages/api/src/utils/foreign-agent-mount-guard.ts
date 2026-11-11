import { realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, posix, relative, resolve } from 'node:path';
import { isPathUnderRoots } from './project-path.js';

const FOREIGN_AGENT_PRIVATE_ROOTS = ['.cac', '.relay', '.config/opencode'];

/** Reserved project-relative prefixes are rejected only when accepting new rules. */
export function isForeignAgentPrivatePath(value: string): boolean {
  const normalized = posix.normalize(value.replaceAll('\\', '/')).toLowerCase();
  return FOREIGN_AGENT_PRIVATE_ROOTS.some((root) => normalized === root || normalized.startsWith(`${root}/`));
}

/** Resolve an absent private root through its nearest existing ancestor. Other I/O errors propagate. */
async function canonicalPath(path: string): Promise<string> {
  return realpath(path).catch(async (error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT' || dirname(path) === path) throw error;
    return join(await canonicalPath(dirname(path)), basename(path));
  });
}

/**
 * Check both the destination coordinate and its physical ancestors. This also catches a private
 * directory-level link pointing back out to our source, before a caller replaces that link.
 */
export async function resolveForeignAgentMountRoot(path: string, home = homedir()): Promise<string | null> {
  const absolutePath = resolve(path);
  const roots = FOREIGN_AGENT_PRIVATE_ROOTS.map((root) => resolve(home, root));
  const lexicalRoot = roots.find((root) => isPathUnderRoots(absolutePath, [root]));
  if (lexicalRoot) return lexicalRoot;

  const canonicalRoots = await Promise.all(roots.map(async (root) => ({ root, path: await canonicalPath(root) })));
  let ancestor = absolutePath;
  while (true) {
    const physical = await realpath(ancestor).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
      return null;
    });
    if (physical) {
      // Missing descendants still count: bridge -> HOME plus .cac/new/skills must be rejected.
      const destination = resolve(physical, relative(ancestor, absolutePath));
      const match = canonicalRoots.find(
        ({ path: root }) => isPathUnderRoots(physical, [root]) || isPathUnderRoots(destination, [root]),
      );
      if (match) return match.root;
    }
    const parent = dirname(ancestor);
    if (parent === ancestor) return null;
    ancestor = parent;
  }
}

/** The final write boundary; production callers use the process home. */
export async function assertMountLinkAllowed(path: string, home = homedir()): Promise<void> {
  const root = await resolveForeignAgentMountRoot(path, home);
  if (root) throw new Error(`Refusing skill mount in foreign agent private directory ${root}: ${path}`);
}
