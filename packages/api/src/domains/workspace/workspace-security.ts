import { getLinkedRootsAsync } from './roots/workspace-linked-roots.js';
import { WorkspaceSecurityError } from './workspace-security-error.js';

export {
  addLinkedRoot,
  getLinkedRoots,
  getLinkedRootsAsync,
  removeLinkedRoot,
} from './roots/workspace-linked-roots.js';
export { WorkspaceSecurityError } from './workspace-security-error.js';

import { realpath, stat } from 'node:fs/promises';
import { basename, dirname, relative, resolve, sep } from 'node:path';
import { resolveStartupProjectRoot } from '../../utils/startup-root.js';
import { readGitWorktreeList } from './git-worktree-probe.js';
import { resolveCurrentWorkspaceContentRoot } from './roots/workspace-content-root-resolution.js';
import { canonicalWorkspaceIdentityRoot, resolveVerifiedScopedWorkspaceAlias } from './workspace-worktree-identity.js';

const DENYLIST_PATTERNS = [/^\.env/, /\.pem$/, /\.key$/, /^id_rsa/];

const DENYLIST_DIRS = new Set(['.git', 'secrets']);

/** UI alias registry populated by /worktrees; not durable content authorization. */
const worktreeRegistry = new Map<string, string>();

export function registerWorktrees(entries: WorktreeEntry[]): void {
  for (const e of entries) worktreeRegistry.set(e.id, e.root);
}

export function assertWorkspacePathAllowed(path: string): void {
  const segments = path.split(sep);
  for (const seg of segments) {
    if (DENYLIST_DIRS.has(seg)) {
      throw new WorkspaceSecurityError(`Access denied: ${seg}`, 'DENIED');
    }
    for (const pat of DENYLIST_PATTERNS) {
      if (pat.test(seg)) {
        throw new WorkspaceSecurityError(`Access denied: ${seg}`, 'DENIED');
      }
    }
  }
}

async function resolveWorkspacePathValue(root: string, pathValue: string): Promise<string> {
  const resolved = resolve(root, pathValue);
  const relFromRoot = relative(root, resolved);
  if (relFromRoot.startsWith('..') || resolve(root, relFromRoot) !== resolved)
    throw new WorkspaceSecurityError('Path outside workspace root', 'TRAVERSAL');
  assertWorkspacePathAllowed(relFromRoot);

  // Symlink escape check: resolve the FULL real path (follows all symlinks
  // in every segment, not just the final one). This catches both
  // "final segment is symlink" AND "intermediate directory is symlink".
  // Also realpath the root to handle cases where root itself traverses
  // symlinks (e.g. macOS /tmp → /private/tmp).
  try {
    const [real, realRoot] = await Promise.all([realpath(resolved), realpath(root)]);
    if (!real.startsWith(realRoot + sep) && real !== realRoot) {
      throw new WorkspaceSecurityError('Symlink escapes workspace root', 'TRAVERSAL');
    }
    // Re-check denylist on the realpath result — a symlink named "safe"
    // pointing to ".env" would pass the pre-realpath check above but the
    // resolved target must still be denied.
    const realRel = relative(realRoot, real);
    for (const seg of realRel.split(sep)) {
      if (DENYLIST_DIRS.has(seg)) {
        throw new WorkspaceSecurityError(`Access denied: ${seg}`, 'DENIED');
      }
      for (const pat of DENYLIST_PATTERNS) {
        if (pat.test(seg)) {
          throw new WorkspaceSecurityError(`Access denied: ${seg}`, 'DENIED');
        }
      }
    }
  } catch (e) {
    if (e instanceof WorkspaceSecurityError) throw e;
    // ENOENT = file doesn't exist yet; traversal check above covers it
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw e;
    }
  }

  return resolved;
}

/**
 * Resolve a URI-shaped, user-provided relative path against a workspace root.
 * Throws on traversal, symlink escape, or denylist match.
 */
export async function resolveWorkspacePath(root: string, userPath: string): Promise<string> {
  return resolveWorkspacePathValue(root, decodeURIComponent(userPath));
}

/**
 * Resolve a native filesystem-relative path without interpreting literal `%`
 * bytes as URI escapes. Absolute-path adapters must use this entry point.
 */
export async function resolveWorkspaceFilesystemPath(root: string, filesystemPath: string): Promise<string> {
  return resolveWorkspacePathValue(root, filesystemPath);
}

/**
 * Check if a relative path matches the denylist (for filtering search results).
 * Returns true if the path should be blocked.
 */
export function isDenylisted(relPath: string): boolean {
  const segments = relPath.split(/[\\/]/);
  for (const seg of segments) {
    if (DENYLIST_DIRS.has(seg)) return true;
    for (const pat of DENYLIST_PATTERNS) {
      if (pat.test(seg)) return true;
    }
  }
  return false;
}

export interface WorktreeEntry {
  rootIdentity?: string;
  id: string;
  canonicalId?: string;
  root: string;
  branch: string;
  head: string;
  removable?: boolean;
  connectionEpoch?: number;
  legacyAliases?: readonly string[];
}

function worktreeIdForRoot(root: string): string {
  return basename(root).replace(/[^a-zA-Z0-9_-]/g, '_');
}

export async function listWorkspaceRootEntries(repoRoot?: string): Promise<WorktreeEntry[]> {
  const [worktrees, linked] = await Promise.all([listWorktrees(repoRoot), getLinkedRootsAsync()]);
  const entries = [...worktrees, ...linked];
  for (const [id, root] of worktreeRegistry.entries()) {
    entries.push({ id, root, branch: 'registered', head: 'registered' });
  }
  return entries;
}

function fallbackWorktreeEntry(root: string): WorktreeEntry {
  return {
    id: worktreeIdForRoot(root),
    root,
    branch: 'exported',
    head: 'nogit',
  };
}

export async function listWorktrees(repoRoot?: string): Promise<WorktreeEntry[]> {
  const cwd = repoRoot ?? process.cwd();
  const stdout = await readGitWorktreeList(cwd);
  if (stdout === null) return [fallbackWorktreeEntry(repoRoot ? resolve(repoRoot) : resolveStartupProjectRoot(cwd))];
  const entries: WorktreeEntry[] = [];
  let current: Partial<WorktreeEntry> = {};

  for (const line of stdout.split('\n')) {
    if (line.startsWith('worktree ')) {
      if (current.root) entries.push(current as WorktreeEntry);
      const root = line.slice('worktree '.length);
      current = {
        root,
        id: worktreeIdForRoot(root),
        branch: 'HEAD',
        head: '',
      };
    } else if (line.startsWith('HEAD ')) {
      current.head = line.slice('HEAD '.length, 'HEAD '.length + 8);
    } else if (line.startsWith('branch ')) {
      const branchRef = line.slice('branch '.length);
      current.branch = branchRef.startsWith('refs/heads/') ? branchRef.slice('refs/heads/'.length) : branchRef;
    }
  }
  if (current.root) entries.push(current as WorktreeEntry);

  // Deduplicate IDs
  const seen = new Set<string>();
  for (const e of entries) {
    if (seen.has(e.id)) e.id = `${e.id}_${e.head}`;
    seen.add(e.id);
  }

  return entries;
}

export async function getWorktreeRoot(worktreeId: string, repoRoot?: string): Promise<string> {
  if (worktreeId.startsWith('f063_root_v1_')) {
    const identity = await resolveCurrentWorkspaceContentRoot(worktreeId, listWorktrees, getLinkedRootsAsync);
    if (identity) return identity.root;
    throw new WorkspaceSecurityError('Canonical workspace root is no longer registered', 'NOT_FOUND');
  }
  const entries = await listWorktrees(repoRoot);
  const entry = entries.find((e) => e.id === worktreeId);
  if (entry) return entry.root;

  // Check linked roots (async to include config file)
  const linked = await getLinkedRootsAsync();
  const linkedMatches = linked.filter((r) => r.id === worktreeId || r.legacyAliases?.includes(worktreeId));
  if (new Set(linkedMatches.map((r) => r.root)).size > 1)
    throw new WorkspaceSecurityError('Linked alias is ambiguous', 'DENIED');
  const linkedEntry = linkedMatches[0];
  if (linkedEntry) {
    if (linkedEntry.rootIdentity && !(await canonicalWorkspaceIdentityRoot(linkedEntry)))
      throw new WorkspaceSecurityError('The confirmed linked directory changed', 'DENIED');
    return linkedEntry.root;
  }

  // Check in-memory registry (populated by /worktrees?repoRoot= calls)
  const registeredRoot = worktreeRegistry.get(worktreeId);
  if (registeredRoot) return registeredRoot;

  const recoveredRoot = await resolveVerifiedScopedWorkspaceAlias({
    worktreeId,
    configuredRoot: process.env.CAT_CAFE_WORKSPACE_ROOT?.trim(),
    currentEntries: entries,
    linkedEntries: linked,
    listWorktrees,
  });
  if (recoveredRoot) return recoveredRoot;

  throw new WorkspaceSecurityError(`Worktree not found: ${worktreeId}`, 'NOT_FOUND');
}

/**
 * Reverse lookup: given an absolute directory path, find its canonical worktreeId.
 * Checks git worktrees, linked roots, and in-memory registry.
 */
export async function resolveWorktreeIdByPath(dirPath: string, repoRoot?: string): Promise<string> {
  const resolved = resolve(dirPath);
  const canonicalResolved = await realpath(resolved).catch(() => resolved);

  const entries = await listWorktrees(repoRoot);
  const entry = (
    await Promise.all(
      entries.map(async (e) => ({
        entry: e,
        canonicalRoot: await realpath(e.root).catch(() => e.root),
      })),
    )
  ).find(({ entry, canonicalRoot }) => entry.root === resolved || canonicalRoot === canonicalResolved)?.entry;
  if (entry) return entry.id;

  const linked = await getLinkedRootsAsync();
  const linkedEntry = (
    await Promise.all(
      linked.map(async (r) => ({
        entry: r,
        canonicalRoot: await realpath(r.root).catch(() => r.root),
      })),
    )
  ).find(({ entry, canonicalRoot }) => entry.root === resolved || canonicalRoot === canonicalResolved)?.entry;
  if (linkedEntry) return linkedEntry.id;

  for (const [id, root] of worktreeRegistry.entries()) {
    const canonicalRoot = await realpath(root).catch(() => root);
    if (root === resolved || canonicalRoot === canonicalResolved) return id;
  }

  throw new WorkspaceSecurityError(`No worktree found for path: ${dirPath}`, 'NOT_FOUND');
}
