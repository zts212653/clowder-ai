/**
 * Workspace Explorer Routes — F063
 *
 * GET  /api/workspace/worktrees    — list git worktrees
 * GET  /api/workspace/tree         — directory tree (depth-limited)
 * GET  /api/workspace/file         — file content + sha256
 * GET  /api/workspace/file/raw     — stream raw image content
 * POST /api/workspace/search       — content / filename search
 * GET  /api/workspace/diff         — git diff for worktree (changed files + unified diff)
 * POST /api/workspace/linked-roots  — add a linked root (name + path)
 * DELETE /api/workspace/linked-roots — remove a linked root by id
 * POST /api/workspace/reveal         — open file in system file manager (Finder/Explorer)
 * POST /api/workspace/navigate       — F131: cat-initiated workspace panel navigation
 *
 * Edit routes: see workspace-edit.ts
 */

import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import type { FastifyPluginAsync } from 'fastify';
import {
  addLinkedRoot,
  getLinkedRootsAsync,
  getWorktreeRoot,
  isDenylisted,
  listWorktrees,
  registerWorktrees,
  removeLinkedRoot,
  resolveWorkspacePath,
  WorkspaceSecurityError,
} from '../domains/workspace/workspace-security.js';

const execFileAsync = promisify(execFile);
const MAX_FILE_SIZE = 1024 * 1024; // 1 MB text preview
const MAX_IMAGE_SIZE = 10 * 1024 * 1024; // 10 MB image preview
const MAX_SEARCH_RESULTS = 100;
const MAX_TREE_DEPTH = 5;
const MAX_CONTENT_SEARCH_FILE_SIZE = 10 * 1024 * 1024; // 10 MB per searchable text file

const CONTENT_SEARCH_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.json',
  '.md',
  '.mdx',
  '.txt',
  '.css',
  '.html',
  '.yaml',
  '.yml',
  '.toml',
  '.sh',
  '.py',
]);

const MIME_MAP: Record<string, string> = {
  '.ts': 'text/typescript',
  '.tsx': 'text/tsx',
  '.js': 'text/javascript',
  '.jsx': 'text/jsx',
  '.json': 'application/json',
  '.md': 'text/markdown',
  '.css': 'text/css',
  '.html': 'text/html',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.yaml': 'text/yaml',
  '.yml': 'text/yaml',
  '.toml': 'text/toml',
  '.sh': 'text/x-shellscript',
  '.py': 'text/x-python',
  // Audio
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.ogg': 'audio/ogg',
  '.flac': 'audio/flac',
  // Video
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
};

function guessMime(filepath: string): string {
  return MIME_MAP[extname(filepath)] ?? 'text/plain';
}

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

interface TreeNode {
  name: string;
  path: string;
  type: 'file' | 'directory';
  children?: TreeNode[];
}

const SKIP_DIRS = new Set(['node_modules', '.next', 'dist', '.git', '.turbo', 'coverage', '.claude']);

interface WorkspaceSearchResult {
  path: string;
  line: number;
  content: string;
  contextBefore: string;
  contextAfter: string;
}

async function listWorkspaceFiles(root: string): Promise<string[]> {
  // Use -prune to skip entire directory trees efficiently.
  // Hidden dirs (.*) are pruned in one rule — covers .venv, .git, .claude,
  // .next, .playwright-mcp, .idea, etc. without listing each one.
  const { stdout } = await execFileAsync(
    'find',
    [
      root,
      '(',
      '-name',
      '.*',
      '-not',
      '-name',
      '.',
      '-type',
      'd',
      ')',
      '-prune',
      '-o',
      '(',
      '-name',
      'node_modules',
      '-type',
      'd',
      ')',
      '-prune',
      '-o',
      '(',
      '-name',
      'dist',
      '-type',
      'd',
      ')',
      '-prune',
      '-o',
      '(',
      '-name',
      'secrets',
      '-type',
      'd',
      ')',
      '-prune',
      '-o',
      '-type',
      'f',
      '-not',
      '-name',
      '.env*',
      '-not',
      '-name',
      '*.pem',
      '-not',
      '-name',
      '*.key',
      '-not',
      '-name',
      'id_rsa*',
      '-print',
    ],
    { timeout: 5000, maxBuffer: 10 * 1024 * 1024 },
  );

  return stdout
    .trim()
    .split('\n')
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b));
}

function isContentSearchable(relPath: string): boolean {
  return CONTENT_SEARCH_EXTENSIONS.has(extname(relPath).toLowerCase());
}

async function searchWorkspaceContent(
  root: string,
  query: string,
  limit: number,
): Promise<{ results: WorkspaceSearchResult[]; truncated: boolean }> {
  const files = await listWorkspaceFiles(root);
  const normalizedQuery = query.toLowerCase();
  const results: WorkspaceSearchResult[] = [];
  let truncated = false;

  for (const fullPath of files) {
    if (results.length >= limit) {
      truncated = true;
      break;
    }

    const relPath = relative(root, fullPath);
    if (isDenylisted(relPath) || !isContentSearchable(relPath)) continue;

    const fileStat = await stat(fullPath).catch(() => null);
    if (!fileStat || fileStat.size > MAX_CONTENT_SEARCH_FILE_SIZE) continue;

    let text = '';
    try {
      text = await readFile(fullPath, 'utf-8');
    } catch {
      continue;
    }

    const lines = text.split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      if (!lines[index]?.toLowerCase().includes(normalizedQuery)) continue;

      results.push({
        path: relPath,
        line: index + 1,
        content: lines[index]?.trim() ?? '',
        contextBefore: lines.slice(Math.max(0, index - 2), index).join('\n'),
        contextAfter: lines.slice(index + 1, index + 3).join('\n'),
      });
      break;
    }
  }

  return { results, truncated };
}

async function buildTree(root: string, dirPath: string, depth: number, maxDepth: number): Promise<TreeNode[]> {
  if (depth >= maxDepth) return [];
  const entries = await readdir(dirPath, { withFileTypes: true });
  const nodes: TreeNode[] = [];

  const sorted = entries.sort((a, b) => {
    if (a.isDirectory() && !b.isDirectory()) return -1;
    if (!a.isDirectory() && b.isDirectory()) return 1;
    return a.name.localeCompare(b.name);
  });

  for (const entry of sorted) {
    if (entry.name.startsWith('.') && entry.name !== '.claude' && entry.name !== '.kimi') continue;
    if (SKIP_DIRS.has(entry.name)) continue;

    const fullPath = join(dirPath, entry.name);
    const relPath = relative(root, fullPath);

    if (entry.isDirectory()) {
      if (depth + 1 >= maxDepth) {
        // At max depth: mark directory as "not loaded" (children: undefined)
        // so frontend knows to lazy-load on expand
        nodes.push({ name: entry.name, path: relPath, type: 'directory' });
      } else {
        const children = await buildTree(root, fullPath, depth + 1, maxDepth);
        nodes.push({ name: entry.name, path: relPath, type: 'directory', children });
      }
    } else {
      nodes.push({ name: entry.name, path: relPath, type: 'file' });
    }
  }
  return nodes;
}

interface WorkspaceRouteOpts {
  socketEmit?: (event: string, data: unknown, room: string) => void;
}

export const workspaceRoutes: FastifyPluginAsync<WorkspaceRouteOpts> = async (app, opts) => {
  // GET /api/workspace/worktrees (includes linked roots)
  app.get<{ Querystring: { repoRoot?: string } }>('/api/workspace/worktrees', async (request, reply) => {
    const { repoRoot } = request.query;
    if (repoRoot) {
      if (!repoRoot.startsWith('/')) {
        reply.status(400);
        return { error: 'repoRoot must be an absolute path' };
      }
      try {
        const s = await stat(repoRoot);
        if (!s.isDirectory()) throw new Error('not a directory');
      } catch {
        reply.status(400);
        return { error: `repoRoot does not exist or is not a directory: ${repoRoot}` };
      }
    }
    const entries = await listWorktrees(repoRoot || undefined);
    // Prefix foreign repo worktree IDs with a short hash to prevent cross-repo collision
    if (repoRoot) {
      const prefix = createHash('sha256').update(repoRoot).digest('hex').slice(0, 6);
      for (const e of entries) e.id = `${prefix}_${e.id}`;
    }
    const linked = await getLinkedRootsAsync();
    const all = [...entries, ...linked];
    registerWorktrees(all);
    return { worktrees: all };
  });

  // GET /api/workspace/tree?worktreeId=&path=&depth=
  app.get<{
    Querystring: { worktreeId?: string; path?: string; depth?: string };
  }>('/api/workspace/tree', async (request, reply) => {
    const { worktreeId, path: subpath, depth: depthStr } = request.query;
    if (!worktreeId) {
      reply.status(400);
      return { error: 'worktreeId required' };
    }

    const depth = Math.min(Number(depthStr ?? 3), MAX_TREE_DEPTH);

    try {
      const root = await getWorktreeRoot(worktreeId);
      const resolved = subpath ? await resolveWorkspacePath(root, subpath) : root;
      const tree = await buildTree(root, resolved, 0, depth);
      return { root: subpath || '.', worktreeId, tree };
    } catch (e) {
      if (e instanceof WorkspaceSecurityError) {
        reply.status(e.code === 'NOT_FOUND' ? 404 : 403);
        return { error: e.message };
      }
      reply.status(500);
      return { error: 'Internal error' };
    }
  });

  // GET /api/workspace/file?worktreeId=&path=
  app.get<{
    Querystring: { worktreeId?: string; path?: string };
  }>('/api/workspace/file', async (request, reply) => {
    const { worktreeId, path: filePath } = request.query;
    if (!worktreeId || !filePath) {
      reply.status(400);
      return { error: 'worktreeId and path required' };
    }

    try {
      const root = await getWorktreeRoot(worktreeId);
      const resolved = await resolveWorkspacePath(root, filePath);
      const fileStat = await stat(resolved);

      if (fileStat.isDirectory()) {
        reply.status(400);
        return { error: 'Path is a directory' };
      }

      const mime = guessMime(resolved);
      const isBinary = mime.startsWith('image/') || mime.startsWith('audio/') || mime.startsWith('video/');

      if (isBinary) {
        return {
          path: filePath,
          content: '',
          sha256: '',
          size: fileStat.size,
          mime,
          truncated: false,
          binary: true,
        };
      }

      const truncated = fileStat.size > MAX_FILE_SIZE;
      const content = await readFile(resolved, 'utf-8');
      const displayContent = truncated ? content.slice(0, MAX_FILE_SIZE) : content;

      return {
        path: filePath,
        content: displayContent,
        sha256: sha256(content),
        size: fileStat.size,
        mime,
        truncated,
      };
    } catch (e) {
      if (e instanceof WorkspaceSecurityError) {
        reply.status(e.code === 'NOT_FOUND' ? 404 : 403);
        return { error: e.message };
      }
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
        reply.status(404);
        return { error: 'File not found' };
      }
      reply.status(500);
      return { error: 'Internal error' };
    }
  });

  // GET /api/workspace/file/raw?worktreeId=&path= — stream raw binary content
  app.get<{
    Querystring: { worktreeId?: string; path?: string };
  }>('/api/workspace/file/raw', async (request, reply) => {
    const { worktreeId, path: filePath } = request.query;
    if (!worktreeId || !filePath) {
      reply.status(400);
      return { error: 'worktreeId and path required' };
    }

    try {
      const root = await getWorktreeRoot(worktreeId);
      const resolved = await resolveWorkspacePath(root, filePath);
      const fileStat = await stat(resolved);

      if (fileStat.isDirectory()) {
        reply.status(400);
        return { error: 'Path is a directory' };
      }

      const mime = guessMime(resolved);
      const isMedia = mime.startsWith('image/') || mime.startsWith('audio/') || mime.startsWith('video/');
      if (!isMedia) {
        reply.status(400);
        return { error: 'Raw endpoint only serves image, audio, and video files' };
      }
      if (fileStat.size > MAX_IMAGE_SIZE) {
        reply.status(413);
        return { error: `File too large (${Math.round(fileStat.size / 1024 / 1024)}MB, max 10MB)` };
      }
      reply.header('Content-Type', mime);
      reply.header('Content-Length', fileStat.size);
      reply.header('Cache-Control', 'private, max-age=60');
      return reply.send(createReadStream(resolved));
    } catch (e) {
      if (e instanceof WorkspaceSecurityError) {
        reply.status(e.code === 'NOT_FOUND' ? 404 : 403);
        return { error: e.message };
      }
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
        reply.status(404);
        return { error: 'File not found' };
      }
      reply.status(500);
      return { error: 'Internal error' };
    }
  });

  // POST /api/workspace/search { worktreeId, query, type?, limit? }
  app.post<{
    Body: { worktreeId: string; query: string; type?: 'content' | 'filename'; limit?: number };
  }>('/api/workspace/search', async (request, reply) => {
    const { worktreeId, query, type, limit: rawLimit } = request.body ?? {};
    if (!worktreeId || !query) {
      reply.status(400);
      return { error: 'worktreeId and query required' };
    }
    if (query.length > 200) {
      reply.status(400);
      return { error: 'Query too long (max 200 chars)' };
    }

    const limit = Math.min(rawLimit ?? 50, MAX_SEARCH_RESULTS);

    try {
      const root = await getWorktreeRoot(worktreeId);

      if (type === 'filename') {
        // List all non-excluded files, then post-filter on the *relative* path.
        // We avoid using find's -path for the query because it matches against
        // the absolute path — if the worktree root itself contains the query
        // string, nearly every file would match (P2 from cloud review).
        const files = await listWorkspaceFiles(root);
        const lowerQuery = query.toLowerCase();
        const results = files
          .map((fullPath) => relative(root, fullPath))
          .filter((relPath) => !isDenylisted(relPath) && relPath.toLowerCase().includes(lowerQuery))
          .slice(0, limit)
          .map((relPath) => ({
            path: relPath,
            line: 0,
            content: '',
            contextBefore: '',
            contextAfter: '',
          }));

        return { query, results, totalMatches: results.length, truncated: false };
      }

      const { results, truncated } = await searchWorkspaceContent(root, query, limit);

      return {
        query,
        results,
        totalMatches: results.length,
        truncated,
      };
    } catch (e) {
      if (e instanceof WorkspaceSecurityError) {
        reply.status(e.code === 'NOT_FOUND' ? 404 : 403);
        return { error: e.message };
      }
      request.log.error({ err: e }, 'workspace search failed');
      reply.status(500);
      return { error: 'Internal error' };
    }
  });

  // GET /api/workspace/diff?worktreeId=&path= — git diff (all changed files or single file)
  app.get<{
    Querystring: { worktreeId?: string; path?: string };
  }>('/api/workspace/diff', async (request, reply) => {
    const { worktreeId, path: filePath } = request.query;
    if (!worktreeId) {
      reply.status(400);
      return { error: 'worktreeId required' };
    }

    try {
      const root = await getWorktreeRoot(worktreeId);

      // Get list of changed files (staged + unstaged)
      const { stdout: statusOut } = await execFileAsync('git', ['status', '--porcelain', '-uall'], {
        cwd: root,
        timeout: 5000,
      });

      const changedFiles = statusOut
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          const status = line.slice(0, 2).trim();
          let path = line.slice(3);
          // Normalize rename paths: "old.ts -> new.ts" → "new.ts"
          // Only apply for rename (R) or copy (C) statuses to avoid
          // misparsing filenames that literally contain " -> "
          if ((status.startsWith('R') || status.startsWith('C')) && path.includes(' -> ')) {
            path = path.slice(path.indexOf(' -> ') + 4);
          }
          return { status, path };
        })
        .filter((f) => !isDenylisted(f.path));

      // Build pathspec: only diff allowed (non-denylisted) files
      // P0 security: git diff without pathspec would leak .env/.pem/.key content
      const allowedPaths = changedFiles.map((f) => f.path);
      if (filePath) {
        await resolveWorkspacePath(root, filePath); // security check
        if (!allowedPaths.includes(filePath)) {
          return { worktreeId, changedFiles, diff: '' };
        }
      }
      const pathspec = filePath ? [filePath] : allowedPaths;

      let diffOutput = '';
      if (pathspec.length > 0) {
        const diffArgs = ['diff', 'HEAD', '--unified=3', '--no-color', '--', ...pathspec];
        try {
          const { stdout } = await execFileAsync('git', diffArgs, {
            cwd: root,
            timeout: 10000,
            maxBuffer: 2 * 1024 * 1024,
          });
          diffOutput = stdout;
        } catch {
          // git diff may fail on initial commits — try without HEAD
          try {
            const fallbackArgs = ['diff', '--cached', '--unified=3', '--no-color', '--', ...pathspec];
            const { stdout } = await execFileAsync('git', fallbackArgs, {
              cwd: root,
              timeout: 10000,
              maxBuffer: 2 * 1024 * 1024,
            });
            diffOutput = stdout;
          } catch {
            // No diff available
          }
        }
      }

      // Supplement diff for untracked (??) files — git diff HEAD doesn't cover them
      const untrackedFiles = changedFiles.filter((f) => f.status === '??');
      const targetUntracked = filePath ? untrackedFiles.filter((f) => f.path === filePath) : untrackedFiles;

      for (const uf of targetUntracked) {
        try {
          await resolveWorkspacePath(root, uf.path); // security check
          // Use relative path so diff headers match changedFiles.path entries
          const { stdout } = await execFileAsync(
            'git',
            ['diff', '--no-index', '--unified=3', '--no-color', '--', '/dev/null', uf.path],
            { cwd: root, timeout: 5000, maxBuffer: 512 * 1024 },
          );
          diffOutput += stdout;
        } catch (err: unknown) {
          // git diff --no-index exits 1 when files differ (expected)
          const e2 = err as { stdout?: string };
          if (e2.stdout) diffOutput += e2.stdout;
        }
      }

      return { worktreeId, changedFiles, diff: diffOutput };
    } catch (e) {
      if (e instanceof WorkspaceSecurityError) {
        reply.status(e.code === 'NOT_FOUND' ? 404 : 403);
        return { error: e.message };
      }
      reply.status(500);
      return { error: 'Internal error' };
    }
  });

  // POST /api/workspace/linked-roots — add a linked root
  app.post<{
    Body: { name?: string; path?: string };
  }>('/api/workspace/linked-roots', async (request, reply) => {
    const { name, path: rootPath } = request.body ?? {};
    if (!name || !rootPath) {
      reply.status(400);
      return { error: 'name and path are required' };
    }
    if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
      reply.status(400);
      return { error: 'name must be alphanumeric (with _ and -)' };
    }
    try {
      const entry = await addLinkedRoot(name, rootPath);
      return { linked: entry };
    } catch (e) {
      if (e instanceof WorkspaceSecurityError) {
        reply.status(e.code === 'NOT_FOUND' ? 404 : 400);
        return { error: e.message };
      }
      reply.status(500);
      return { error: 'Internal error' };
    }
  });

  // DELETE /api/workspace/linked-roots?id=
  app.delete<{
    Querystring: { id?: string };
  }>('/api/workspace/linked-roots', async (request, reply) => {
    const { id } = request.query;
    if (!id) {
      reply.status(400);
      return { error: 'id is required' };
    }
    const removed = await removeLinkedRoot(id);
    if (!removed) {
      reply.status(404);
      return { error: 'Linked root not found in config' };
    }
    return { ok: true };
  });

  // POST /api/workspace/reveal — open file/directory in system file manager
  app.post<{
    Body: { worktreeId: string; path: string };
  }>('/api/workspace/reveal', async (request, reply) => {
    const { worktreeId, path: filePath } = request.body ?? {};
    if (!worktreeId || !filePath) {
      reply.status(400);
      return { error: 'worktreeId and path required' };
    }
    try {
      const root = await getWorktreeRoot(worktreeId);
      const resolved = await resolveWorkspacePath(root, filePath);
      if (process.platform === 'darwin') {
        // macOS: open -R reveals the file in Finder
        await execFileAsync('open', ['-R', resolved], { timeout: 5000 });
      } else if (process.platform === 'win32') {
        await execFileAsync('explorer', ['/select,', resolved], { timeout: 5000 });
      } else {
        // Linux: xdg-open can only open directories, not select files
        const fileStat = await stat(resolved);
        const dir = fileStat.isDirectory() ? resolved : dirname(resolved);
        await execFileAsync('xdg-open', [dir], { timeout: 5000 });
      }
      return { ok: true };
    } catch (e) {
      if (e instanceof WorkspaceSecurityError) {
        reply.status(e.code === 'NOT_FOUND' ? 404 : 403);
        return { error: e.message };
      }
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
        reply.status(404);
        return { error: 'File not found' };
      }
      reply.status(500);
      return { error: 'Failed to reveal file' };
    }
  });

  // F095 Phase F: POST /api/workspace/reveal-project — open project directory in Finder
  app.post<{
    Body: { projectPath: string };
  }>('/api/workspace/reveal-project', async (request, reply) => {
    const { projectPath } = request.body ?? {};
    if (!projectPath) {
      reply.status(400);
      return { error: 'projectPath required' };
    }
    try {
      // Security: validate projectPath is within a registered worktree/linked root.
      // projectPath can be a root OR a subdirectory (e.g. packages/web inside a monorepo).
      const allRoots = [...(await listWorktrees()), ...(await getLinkedRootsAsync())];
      const absPath = resolve(projectPath);
      const matchedRoot = allRoots.find((e) => {
        const rel = relative(e.root, absPath);
        // Guard: absolute rel = cross-drive (Windows), `..` + sep = parent traversal.
        // Use `..${sep}` to avoid false-blocking dirs named e.g. `..cache`.
        const escapes = rel === '..' || rel.startsWith(`..${sep}`);
        return !isAbsolute(rel) && !escapes && resolve(e.root, rel) === absPath;
      });
      if (!matchedRoot) {
        throw new WorkspaceSecurityError('Path not in any registered workspace', 'NOT_FOUND');
      }
      // Full security check (traversal, symlink, denylist)
      const relPath = relative(matchedRoot.root, absPath) || '.';
      await resolveWorkspacePath(matchedRoot.root, relPath);

      const fileStat = await stat(projectPath);
      if (!fileStat.isDirectory()) {
        reply.status(400);
        return { error: 'Not a directory' };
      }
      if (process.platform === 'darwin') {
        await execFileAsync('open', [projectPath], { timeout: 5000 });
      } else if (process.platform === 'win32') {
        await execFileAsync('explorer', [projectPath], { timeout: 5000 });
      } else {
        await execFileAsync('xdg-open', [projectPath], { timeout: 5000 });
      }
      return { ok: true };
    } catch (e) {
      if (e instanceof WorkspaceSecurityError) {
        reply.status(403);
        return { error: 'Path not in a registered workspace' };
      }
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
        reply.status(404);
        return { error: 'Directory not found' };
      }
      reply.status(500);
      return { error: 'Failed to open directory' };
    }
  });

  // POST /api/workspace/navigate — F131: cat-initiated workspace panel navigation
  app.post<{
    Body: {
      worktreeId?: string;
      path?: string;
      action?: 'reveal' | 'open' | 'knowledge-feed';
      line?: number;
      threadId?: string;
    };
  }>('/api/workspace/navigate', async (request, reply) => {
    const { worktreeId, path: filePath, action = 'reveal', line, threadId } = request.body ?? {};

    // Phase H: knowledge-feed action switches workspace mode without requiring a file path
    // threadId is required to avoid broadcasting mode switch to all sessions
    if (action === 'knowledge-feed') {
      if (!threadId) {
        reply.status(400);
        return { error: 'threadId required for knowledge-feed action' };
      }
      const eventData = { path: '', worktreeId: worktreeId ?? '', action, threadId, eventId: randomUUID() };
      opts.socketEmit?.('workspace:navigate', eventData, 'workspace:global');
      return { ok: true, action };
    }

    if (!worktreeId || !filePath) {
      reply.status(400);
      return { error: 'worktreeId and path required' };
    }

    try {
      const root = await getWorktreeRoot(worktreeId);
      const resolved = await resolveWorkspacePath(root, filePath);
      await stat(resolved);
    } catch (e) {
      if (e instanceof WorkspaceSecurityError) {
        reply.status(e.code === 'NOT_FOUND' ? 404 : 403);
        return { error: e.message };
      }
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
        reply.status(404);
        return { error: 'File not found' };
      }
      reply.status(500);
      return { error: 'Internal error' };
    }

    const eventData = { path: filePath, worktreeId, action, line, threadId, eventId: randomUUID() };
    if (worktreeId) {
      opts.socketEmit?.('workspace:navigate', eventData, `worktree:${worktreeId}`);
      opts.socketEmit?.('workspace:navigate', eventData, 'workspace:global');
    } else {
      opts.socketEmit?.('workspace:navigate', eventData, 'workspace:global');
    }

    return { ok: true, path: filePath, action };
  });
};
