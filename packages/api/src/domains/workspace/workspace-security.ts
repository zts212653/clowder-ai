import { execFile } from 'node:child_process';
import { mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { resolveStartupProjectRoot } from '../../utils/startup-root.js';

const execFileAsync = promisify(execFile);

const DENYLIST_PATTERNS = [/^\.env/i, /\.pem$/i, /\.key$/i, /^id_rsa/i];

const DENYLIST_DIRS = new Set(['.git', 'secrets', '.cat-cafe']);

/** Case-insensitive segment match for protected directories. */
function isProtectedDirSegment(seg: string): boolean {
  return DENYLIST_DIRS.has(seg.toLowerCase());
}

function assertDenylistAllowed(relPath: string): void {
  for (const seg of relPath.split(sep)) {
    if (!seg) continue;
    if (isProtectedDirSegment(seg)) {
      throw new WorkspaceSecurityError(`Access denied: ${seg}`, 'DENIED');
    }
    for (const pat of DENYLIST_PATTERNS) {
      if (pat.test(seg)) {
        throw new WorkspaceSecurityError(`Access denied: ${seg}`, 'DENIED');
      }
    }
  }
}

/**
 * Reject if the canonical workspace root itself is inside a protected namespace.
 * This closes the attack where workDir = .../project/.cat-cafe and relative paths
 * from it bypass the segment denylist.
 */
function assertRootNotProtected(canonicalRoot: string): void {
  for (const seg of canonicalRoot.split(/[\\/]/)) {
    if (seg && isProtectedDirSegment(seg)) {
      throw new WorkspaceSecurityError(`Workspace root contains protected segment: ${seg}`, 'DENIED');
    }
  }
}

function assertInsideRoot(root: string, resolved: string): string {
  const relFromRoot = relative(root, resolved);
  if (relFromRoot.startsWith('..') || resolve(root, relFromRoot) !== resolved) {
    throw new WorkspaceSecurityError('Path outside workspace root', 'TRAVERSAL');
  }
  return relFromRoot;
}

function assertRealPathInside(realRoot: string, real: string): void {
  if (!real.startsWith(realRoot + sep) && real !== realRoot) {
    throw new WorkspaceSecurityError('Symlink escapes workspace root', 'TRAVERSAL');
  }
}

async function isExistingDirectory(path: string): Promise<boolean> {
  try {
    const pathStat = await stat(path);
    if (!pathStat.isDirectory()) {
      throw new WorkspaceSecurityError('Parent path is not a directory', 'TRAVERSAL');
    }
    return true;
  } catch (err) {
    if (err instanceof WorkspaceSecurityError) throw err;
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
}

async function findExistingDirectoryAncestor(resolvedRoot: string, initialAncestor: string): Promise<string> {
  let ancestor = initialAncestor;
  for (;;) {
    const relAncestor = assertInsideRoot(resolvedRoot, ancestor);
    assertDenylistAllowed(relAncestor);

    if (await isExistingDirectory(ancestor)) {
      return ancestor;
    }

    if (ancestor === resolvedRoot) {
      throw new WorkspaceSecurityError('Workspace root does not exist', 'NOT_FOUND');
    }
    const parent = dirname(ancestor);
    if (parent === ancestor) {
      throw new WorkspaceSecurityError('Path outside workspace root', 'TRAVERSAL');
    }
    ancestor = parent;
  }
}

/**
 * In-memory registry: worktreeId → absolute root path.
 * Populated when /api/workspace/worktrees lists foreign repos.
 * Allows getWorktreeRoot to resolve foreign worktrees without repoRoot.
 */
const worktreeRegistry = new Map<string, string>();

/** Register worktree entries so getWorktreeRoot can resolve them later. */
export function registerWorktrees(entries: WorktreeEntry[]): void {
  for (const e of entries) worktreeRegistry.set(e.id, e.root);
}

export class WorkspaceSecurityError extends Error {
  constructor(
    message: string,
    public readonly code: 'TRAVERSAL' | 'DENIED' | 'NOT_FOUND',
  ) {
    super(message);
    this.name = 'WorkspaceSecurityError';
  }
}

/**
 * Resolve a user-provided relative path against a workspace root.
 * Throws on traversal, symlink escape, or denylist match.
 */
export async function resolveWorkspacePath(root: string, userPath: string): Promise<string> {
  const decoded = decodeURIComponent(userPath);
  const resolved = resolve(root, decoded);
  const relFromRoot = assertInsideRoot(root, resolved);
  assertDenylistAllowed(relFromRoot);

  // Symlink escape check: resolve the FULL real path (follows all symlinks
  // in every segment, not just the final one). This catches both
  // "final segment is symlink" AND "intermediate directory is symlink".
  // Also realpath the root to handle cases where root itself traverses
  // symlinks (e.g. macOS /tmp → /private/tmp).
  //
  // The root is resolved INDEPENDENTLY before the target so that
  // assertRootNotProtected always fires — even when the target does not
  // exist yet (realpath(resolved) would throw ENOENT and a Promise.all
  // would reject before the root check runs). Matches the pattern in
  // resolveWorkspaceCreatePath.
  try {
    const realRoot = await realpath(root);
    // Canonical root must not itself be inside a protected namespace.
    assertRootNotProtected(realRoot);

    try {
      const real = await realpath(resolved);
      assertRealPathInside(realRoot, real);
      // Re-check denylist on the realpath result — a symlink named "safe"
      // pointing to ".env" would pass the pre-realpath check above but the
      // resolved target must still be denied.
      const realRel = relative(realRoot, real);
      assertDenylistAllowed(realRel);
    } catch (e) {
      if (e instanceof WorkspaceSecurityError) throw e;
      // ENOENT = target file doesn't exist yet; lexical traversal check above covers it
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
  } catch (e) {
    if (e instanceof WorkspaceSecurityError) throw e;
    // ENOENT from realpath(root) = root doesn't exist; lexical checks above cover it
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }

  return resolved;
}

/**
 * Resolve a path that may be created by a write operation.
 *
 * Unlike resolveWorkspacePath(), this validates the nearest existing ancestor
 * instead of accepting ENOENT after only lexical traversal checks. That closes
 * the "workspace/safe-link/new.txt" case where "safe-link" is a symlink to a
 * directory outside the workspace.
 */
export async function resolveWorkspaceCreatePath(root: string, userPath: string): Promise<string> {
  const decoded = decodeURIComponent(userPath);
  const resolvedRoot = resolve(root);
  const resolved = resolve(resolvedRoot, decoded);
  const relFromRoot = assertInsideRoot(resolvedRoot, resolved);
  assertDenylistAllowed(relFromRoot);

  const realRoot = await realpath(resolvedRoot);
  // Canonical root must not itself be inside a protected namespace.
  assertRootNotProtected(realRoot);
  const ancestor = await findExistingDirectoryAncestor(resolvedRoot, dirname(resolved));
  const realAncestor = await realpath(ancestor);
  assertRealPathInside(realRoot, realAncestor);
  assertDenylistAllowed(relative(realRoot, realAncestor));
  return resolved;
}

/**
 * Check if a relative path matches the denylist (for filtering search results).
 * Returns true if the path should be blocked.
 */
export function isDenylisted(relPath: string): boolean {
  const segments = relPath.split(/[\\/]/);
  for (const seg of segments) {
    if (isProtectedDirSegment(seg)) return true;
    for (const pat of DENYLIST_PATTERNS) {
      if (pat.test(seg)) return true;
    }
  }
  return false;
}

/**
 * Check if an absolute path contains a protected namespace segment.
 * Case-insensitive to prevent .CAT-CAFE / .Git / Secrets bypass.
 *
 * Returns the first matched protected segment, or null if the path is safe.
 */
export function containsProtectedSegment(absolutePath: string): string | null {
  for (const seg of absolutePath.split(/[\\/]/)) {
    if (seg && isProtectedDirSegment(seg)) return seg;
  }
  return null;
}

export interface WorktreeEntry {
  id: string;
  canonicalId?: string;
  root: string;
  branch: string;
  head: string;
}

function worktreeIdForRoot(root: string): string {
  return basename(root).replace(/[^a-zA-Z0-9_-]/g, '_');
}

function isGitWorktreeUnavailableError(err: unknown): boolean {
  const code = typeof err === 'object' && err !== null && 'code' in err ? String((err as { code?: unknown }).code) : '';
  const stderr =
    typeof err === 'object' && err !== null && 'stderr' in err ? String((err as { stderr?: unknown }).stderr) : '';
  return code === 'ENOENT' || (code === '128' && stderr.includes('not a git repository'));
}

function fallbackWorktreeEntry(cwd: string): WorktreeEntry {
  const root = resolveStartupProjectRoot(cwd);
  return {
    id: worktreeIdForRoot(root),
    root,
    branch: 'exported',
    head: 'nogit',
  };
}

export async function listWorktrees(repoRoot?: string): Promise<WorktreeEntry[]> {
  const cwd = repoRoot ?? process.cwd();
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync('git', ['worktree', 'list', '--porcelain'], { cwd }));
  } catch (err) {
    if (isGitWorktreeUnavailableError(err)) return [fallbackWorktreeEntry(cwd)];
    throw err;
  }
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
  const entries = await listWorktrees(repoRoot);
  const entry = entries.find((e) => e.id === worktreeId);
  if (entry) return entry.root;

  // Check linked roots (async to include config file)
  const linked = await getLinkedRootsAsync();
  const linkedEntry = linked.find((r) => r.id === worktreeId);
  if (linkedEntry) return linkedEntry.root;

  // Check in-memory registry (populated by /worktrees?repoRoot= calls)
  const registeredRoot = worktreeRegistry.get(worktreeId);
  if (registeredRoot) return registeredRoot;

  throw new WorkspaceSecurityError(`Worktree not found: ${worktreeId}`, 'NOT_FOUND');
}

/**
 * Reverse lookup: given an absolute directory path, find its canonical worktreeId.
 * Checks git worktrees, linked roots, and in-memory registry.
 */
export async function resolveWorktreeIdByPath(dirPath: string, repoRoot?: string): Promise<string> {
  const resolved = resolve(dirPath);

  const entries = await listWorktrees(repoRoot);
  const entry = entries.find((e) => e.root === resolved);
  if (entry) return entry.id;

  const linked = await getLinkedRootsAsync();
  const linkedEntry = linked.find((r) => r.root === resolved);
  if (linkedEntry) return linkedEntry.id;

  for (const [id, root] of worktreeRegistry.entries()) {
    if (root === resolved) return id;
  }

  throw new WorkspaceSecurityError(`No worktree found for path: ${dirPath}`, 'NOT_FOUND');
}

/** Build a linked root entry from name + path */
function toLinkedEntry(name: string, rootPath: string): WorktreeEntry {
  return {
    id: `linked_${name.replace(/[^a-zA-Z0-9_-]/g, '_')}`,
    root: resolve(rootPath),
    branch: name,
    head: 'linked',
  };
}

/** Config file path for persistent linked roots */
function linkedRootsConfigPath(): string {
  return resolve(process.cwd(), '.cat-cafe', 'linked-roots.json');
}

/** Read persisted linked roots from config file */
async function readLinkedRootsConfig(): Promise<Array<{ name: string; path: string }>> {
  try {
    const data = await readFile(linkedRootsConfigPath(), 'utf-8');
    const parsed = JSON.parse(data);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** Write linked roots config file */
async function writeLinkedRootsConfig(entries: Array<{ name: string; path: string }>): Promise<void> {
  const configPath = linkedRootsConfigPath();
  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(configPath, `${JSON.stringify(entries, null, 2)}\n`, 'utf-8');
}

/**
 * Get all linked roots: env var + config file (merged, deduped by id).
 * Format: env var "name:path,name:path" + .cat-cafe/linked-roots.json
 */
export function getLinkedRoots(): WorktreeEntry[] {
  // From env var
  const envRoots: WorktreeEntry[] = [];
  const raw = process.env.WORKSPACE_LINKED_ROOTS;
  if (raw) {
    for (const segment of raw.split(',')) {
      const trimmed = segment.trim();
      if (!trimmed) continue;
      const colonIdx = trimmed.indexOf(':');
      if (colonIdx <= 0) continue;
      envRoots.push(toLinkedEntry(trimmed.slice(0, colonIdx).trim(), trimmed.slice(colonIdx + 1).trim()));
    }
  }
  return envRoots;
}

/**
 * Get all linked roots (async — includes config file).
 * Merges env var roots + config file, deduped by id.
 */
export async function getLinkedRootsAsync(): Promise<WorktreeEntry[]> {
  const envRoots = getLinkedRoots();
  const configEntries = await readLinkedRootsConfig();
  const configRoots = configEntries.map((e) => toLinkedEntry(e.name, e.path));

  // Dedup: env wins on conflict
  const seen = new Set(envRoots.map((r) => r.id));
  const merged = [...envRoots];
  for (const cr of configRoots) {
    if (!seen.has(cr.id)) {
      merged.push(cr);
      seen.add(cr.id);
    }
  }
  return merged;
}

/** Add a linked root to the config file. Validates path exists. */
export async function addLinkedRoot(name: string, rootPath: string): Promise<WorktreeEntry> {
  const resolved = resolve(rootPath);
  // Validate path exists and is a directory
  const st = await stat(resolved).catch(() => null);
  if (!st || !st.isDirectory()) {
    throw new WorkspaceSecurityError(`Path is not a directory: ${resolved}`, 'NOT_FOUND');
  }

  const entries = await readLinkedRootsConfig();
  const entry = toLinkedEntry(name, resolved);
  // Replace if same name exists
  const filtered = entries.filter((e) => toLinkedEntry(e.name, e.path).id !== entry.id);
  filtered.push({ name, path: resolved });
  await writeLinkedRootsConfig(filtered);
  return entry;
}

/** Remove a linked root from the config file by id. */
export async function removeLinkedRoot(linkedId: string): Promise<boolean> {
  const entries = await readLinkedRootsConfig();
  const filtered = entries.filter((e) => toLinkedEntry(e.name, e.path).id !== linkedId);
  if (filtered.length === entries.length) return false;
  await writeLinkedRootsConfig(filtered);
  return true;
}
