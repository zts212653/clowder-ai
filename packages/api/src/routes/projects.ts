/**
 * Project Directory Browser Routes
 * GET /api/projects/browse        - 浏览目录结构
 * GET /api/projects/cwd           - 获取服务器工作目录
 * POST /api/projects/pick-directory - 打开系统原生文件选择器
 */

import { execFile } from 'node:child_process';
import { readdir, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, posix, resolve, win32 } from 'node:path';
import { promisify } from 'node:util';
import type { FastifyPluginAsync } from 'fastify';
import { getAllowedRoots, isUnderAllowedRoot, validateProjectPath } from '../utils/project-path.js';
import { resolveUserId } from '../utils/request-identity.js';

const execFileAsync = promisify(execFile);

const WINDOWS_PICK_DIRECTORY_SCRIPT = [
  'Add-Type -AssemblyName System.Windows.Forms',
  '$dialog = New-Object System.Windows.Forms.FolderBrowserDialog',
  '$dialog.ShowNewFolderButton = $false',
  '$dialog.Description = "Select project directory"',
  'if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {',
  '  [Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
  '  Write-Output $dialog.SelectedPath',
  '}',
].join('; ');

export type PickDirectoryResult =
  | { status: 'picked'; path: string }
  | { status: 'cancelled' }
  | { status: 'error'; message: string };

export interface NativeDirectoryPickerCommand {
  command: string;
  args: string[];
}

export function normalizePickedDirectoryPath(rawPath: string): string {
  const trimmed = rawPath.trim();
  if (/^[A-Za-z]:[\\/]?$/.test(trimmed)) {
    return `${trimmed[0]}:\\`;
  }
  return trimmed.replace(/[\\/]$/, '');
}

export function getPickDirectoryCommand(platformName = process.platform): NativeDirectoryPickerCommand | null {
  switch (platformName) {
    case 'darwin':
      return { command: 'osascript', args: ['-e', 'POSIX path of (choose folder)'] };
    case 'win32':
      return {
        command: 'powershell.exe',
        args: ['-NoProfile', '-STA', '-Command', WINDOWS_PICK_DIRECTORY_SCRIPT],
      };
    default:
      return null;
  }
}

function getPathApi(platformName = process.platform) {
  return platformName === 'win32' ? win32 : posix;
}

export function splitProjectCompletePrefix(
  prefix: string,
  cwd: string,
  platformName = process.platform,
): { parentDir: string; fragment: string } {
  const pathApi = getPathApi(platformName);
  const expandedPrefix =
    prefix.startsWith('~/') || (platformName === 'win32' && prefix.startsWith('~\\'))
      ? homedir() + prefix.slice(1)
      : prefix;
  const absPrefix = pathApi.resolve(cwd, expandedPrefix);
  const hasTrailingSeparator = platformName === 'win32' ? /[\\/]$/.test(prefix) : prefix.endsWith('/');
  return {
    parentDir: hasTrailingSeparator ? absPrefix : pathApi.dirname(absPrefix),
    fragment: hasTrailingSeparator ? '' : pathApi.basename(absPrefix),
  };
}

export function getProjectBrowseParent(validatedPath: string, platformName = process.platform): string | null {
  const pathApi = getPathApi(platformName);
  const parent = pathApi.dirname(validatedPath);
  return parent === validatedPath ? null : parent;
}

/**
 * Shell out to the host OS native folder picker.
 * Returns a discriminated result: picked / cancelled / error.
 */
export async function execPickDirectory(): Promise<PickDirectoryResult> {
  const picker = getPickDirectoryCommand();
  if (!picker) {
    return {
      status: 'error',
      message: `Native directory picker is not supported on ${process.platform}. Enter the project path manually.`,
    };
  }

  try {
    const { stdout } = await execFileAsync(picker.command, picker.args, { timeout: 120_000 });
    const picked = normalizePickedDirectoryPath(stdout);
    if (!picked) return { status: 'cancelled' };
    const s = await stat(picked);
    if (!s.isDirectory()) return { status: 'error', message: 'Selected path is not a directory' };
    return { status: 'picked', path: picked };
  } catch (err: unknown) {
    // osascript reports "User canceled. (-128)" in stderr when user presses Cancel.
    // Exit code 1 is generic — also used for permission denial, script errors, etc.
    // Only treat explicit "User canceled" as cancellation.
    const stderr = String((err as { stderr?: unknown }).stderr ?? '');
    if (stderr.includes('User canceled')) return { status: 'cancelled' };
    return { status: 'error', message: stderr || (err instanceof Error ? err.message : 'Unknown error') };
  }
}

/** Swappable reference for testing — route calls this instead of execPickDirectory directly */
export let _pickDirectoryImpl: () => Promise<PickDirectoryResult> = execPickDirectory;
export function setPickDirectoryImpl(fn: () => Promise<PickDirectoryResult>): void {
  _pickDirectoryImpl = fn;
}

export interface ProjectEntry {
  name: string;
  path: string;
  isDirectory: boolean;
}

export const projectsRoutes: FastifyPluginAsync = async (app) => {
  // GET /api/projects/cwd - return server's working directory
  app.get('/api/projects/cwd', async () => {
    const cwd = process.cwd();
    return { path: cwd, name: basename(cwd) };
  });

  // POST /api/projects/pick-directory - open native macOS folder picker
  app.post('/api/projects/pick-directory', async (request, reply) => {
    const userId = resolveUserId(request);
    if (!userId) {
      reply.status(401);
      return { error: 'Identity required (X-Cat-Cafe-User header or userId query)' };
    }
    const result = await _pickDirectoryImpl();
    if (result.status === 'cancelled') {
      reply.status(204);
      return;
    }
    if (result.status === 'error') {
      reply.status(500);
      return { error: result.message };
    }
    const validated = await validateProjectPath(result.path);
    if (!validated) {
      reply.status(403);
      return {
        error: 'Selected directory is outside allowed roots',
        selectedPath: result.path,
        allowedRoots: getAllowedRoots(),
      };
    }
    return { path: validated, name: basename(validated) };
  });

  // GET /api/projects/complete?prefix=src/comp&cwd=/path/to/project&limit=10
  app.get('/api/projects/complete', async (request, reply) => {
    const query = request.query as { prefix?: string; cwd?: string; limit?: string };
    if (!query.prefix && query.prefix !== '') {
      reply.status(400);
      return { error: 'prefix parameter is required' };
    }
    const prefix = query.prefix;
    const limit = Math.min(Math.max(parseInt(query.limit || '10', 10) || 10, 1), 50);

    // Resolve prefix: expand ~ to homedir, then resolve relative paths
    const cwd = query.cwd || process.cwd();
    const { parentDir, fragment } = splitProjectCompletePrefix(prefix, cwd);

    // Validate parent directory
    const validatedParent = await validateProjectPath(parentDir);
    if (!validatedParent) {
      reply.status(403);
      return { error: 'Access denied: path is outside allowed roots' };
    }

    try {
      const entries = await readdir(validatedParent, { withFileTypes: true });
      const results: ProjectEntry[] = [];

      for (const entry of entries) {
        if (entry.name.startsWith('.')) continue;
        if (entry.name === 'node_modules') continue;
        if (fragment && !entry.name.startsWith(fragment)) continue;

        const childPath = resolve(validatedParent, entry.name);
        try {
          const childReal = await realpath(childPath);
          if (!isUnderAllowedRoot(childReal)) continue;
          const isDir = entry.isDirectory();
          results.push({
            name: isDir ? `${entry.name}/` : entry.name,
            path: childReal,
            isDirectory: isDir,
          });
        } catch {}
      }

      // Sort: directories first, then alphabetically within each group
      results.sort((a, b) => {
        if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
        return a.name.localeCompare(b.name);
      });

      return { entries: results.slice(0, limit) };
    } catch {
      return { entries: [] };
    }
  });

  // GET /api/projects/browse?path=/some/dir - list subdirectories
  app.get('/api/projects/browse', async (request, reply) => {
    const query = request.query as { path?: string };
    const targetPath = query.path || homedir();

    // Validate path: realpath() resolves symlinks, then boundary check
    const validatedPath = await validateProjectPath(targetPath);
    if (!validatedPath) {
      reply.status(403);
      return { error: 'Access denied: path is outside allowed roots' };
    }

    try {
      const entries = await readdir(validatedPath, { withFileTypes: true });
      const dirs: ProjectEntry[] = [];

      for (const entry of entries) {
        // Skip hidden dirs (., .., .git, .node_modules, etc.)
        if (entry.name.startsWith('.')) continue;
        // Skip node_modules
        if (entry.name === 'node_modules') continue;

        if (entry.isDirectory()) {
          // Resolve child realpath to prevent symlink escape in entries
          const childPath = resolve(validatedPath, entry.name);
          try {
            const childReal = await realpath(childPath);
            if (!isUnderAllowedRoot(childReal)) continue;
            dirs.push({ name: entry.name, path: childReal, isDirectory: true });
          } catch {}
        }
      }

      // Sort alphabetically
      dirs.sort((a, b) => a.name.localeCompare(b.name));

      // Compute parent (use validatedPath which is already canonicalized)
      const parent = getProjectBrowseParent(validatedPath);
      const canGoUp = parent !== null && isUnderAllowedRoot(parent);

      return {
        current: validatedPath,
        name: basename(validatedPath),
        parent: canGoUp ? parent : null,
        entries: dirs,
      };
    } catch (err) {
      reply.status(400);
      return {
        error: `Cannot read directory: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  });
};
