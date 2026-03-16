import { execFile } from 'node:child_process';
import { mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const DENYLIST_PATTERNS = [/^\.env/, /\.pem$/, /\.key$/, /^id_rsa/];

const DENYLIST_DIRS = new Set(['.git', 'secrets']);

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
  const relFromRoot = relative(root, resolved);

  if (relFromRoot.startsWith('..') || resolve(root, relFromRoot) !== resolved) {
    throw new WorkspaceSecurityError('Path outside workspace root', 'TRAVERSAL');
  }

  const segments = relFromRoot.split(sep);
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
 * Check if a relative path matches the denylist (for filtering search results).
 * Returns true if the path should be blocked.
 */
export function isDenylisted(relPath: string): boolean {
  const segments = relPath.split(sep);
  for (const seg of segments) {
    if (DENYLIST_DIRS.has(seg)) return true;
    for (const pat of DENYLIST_PATTERNS) {
      if (pat.test(seg)) return true;
    }
  }
  return false;
}

export interface WorktreeEntry {
  id: string;
  root: string;
  branch: string;
  head: string;
}

export async function listWorktrees(repoRoot?: string): Promise<WorktreeEntry[]> {
  const cwd = repoRoot ?? process.cwd();
  const { stdout } = await execFileAsync('git', ['worktree', 'list', '--porcelain'], { cwd });
  const entries: WorktreeEntry[] = [];
  let current: Partial<WorktreeEntry> = {};

  for (const line of stdout.split('\n')) {
    if (line.startsWith('worktree ')) {
      if (current.root) entries.push(current as WorktreeEntry);
      const root = line.slice('worktree '.length);
      current = {
        root,
        id: basename(root).replace(/[^a-zA-Z0-9_-]/g, '_'),
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
