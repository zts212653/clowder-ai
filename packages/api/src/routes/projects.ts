/**
 * Project Directory Browser Routes
 * GET /api/projects/browse        - 浏览目录结构
 * GET /api/projects/cwd           - 获取服务器工作目录
 * POST /api/projects/pick-directory - 打开系统原生文件选择器
 */

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readdir, realpath, stat, unlink, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { FastifyPluginAsync } from 'fastify';
import { getAllowedRoots, isUnderAllowedRoot, validateProjectPath } from '../utils/project-path.js';
import { resolveUserId } from '../utils/request-identity.js';

const execFileAsync = promisify(execFile);

export type PickDirectoryResult =
  | { status: 'picked'; path: string }
  | { status: 'cancelled' }
  | { status: 'error'; message: string };

/**
 * Open native folder picker dialog.
 * - macOS: osascript → NSOpenPanel
 * - Windows: PowerShell → System.Windows.Forms.FolderBrowserDialog
 * Returns a discriminated result: picked / cancelled / error.
 */
export async function execPickDirectory(): Promise<PickDirectoryResult> {
  if (process.platform === 'win32') {
    return execPickDirectoryWindows();
  }
  return execPickDirectoryMac();
}

async function execPickDirectoryMac(): Promise<PickDirectoryResult> {
  try {
    const { stdout } = await execFileAsync('osascript', ['-e', 'POSIX path of (choose folder)'], { timeout: 120_000 });
    const picked = stdout.trim().replace(/\/$/, '');
    if (!picked) return { status: 'cancelled' };
    const s = await stat(picked);
    if (!s.isDirectory()) return { status: 'error', message: 'Selected path is not a directory' };
    return { status: 'picked', path: picked };
  } catch (err: unknown) {
    const stderr = String((err as { stderr?: unknown }).stderr ?? '');
    if (stderr.includes('User canceled')) return { status: 'cancelled' };
    return { status: 'error', message: stderr || (err instanceof Error ? err.message : 'Unknown error') };
  }
}

/** C# source for the native folder picker — compiled once, cached as .exe */
const PICKER_CS = `
using System;
using System.Runtime.InteropServices;
using System.Windows.Forms;
class Program {
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr hWnd);
    [STAThread]
    static void Main() {
        var f = new Form { TopMost = true, Size = new System.Drawing.Size(1,1),
                           StartPosition = FormStartPosition.CenterScreen };
        f.Show();
        SetForegroundWindow(f.Handle);
        f.BringToFront();
        var d = new FolderBrowserDialog { Description = "Select project directory",
                                          ShowNewFolderButton = true };
        var r = d.ShowDialog(f);
        f.Close();
        Console.Write(r == DialogResult.OK ? d.SelectedPath : "::CANCELLED::");
    }
}`.trimStart();

let pickerExePath: string | undefined;

/**
 * Ensure the native folder-picker .exe exists (compile on first call).
 * Uses .NET Framework csc.exe which ships with every Windows install.
 */
async function ensurePickerExe(): Promise<string> {
  if (pickerExePath && existsSync(pickerExePath)) return pickerExePath;
  const exePath = join(tmpdir(), 'cat-cafe-pick-folder.exe');
  if (existsSync(exePath)) { pickerExePath = exePath; return exePath; }
  const csPath = join(tmpdir(), 'cat-cafe-pick-folder.cs');
  await writeFile(csPath, PICKER_CS, 'utf8');
  const cscDir = 'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319';
  const { stderr } = await execFileAsync(
    'powershell', ['-NoProfile', '-Command',
      `& '${cscDir}\\csc.exe' /nologo /target:winexe '/out:${exePath}' /reference:System.Windows.Forms.dll /reference:System.Drawing.dll '${csPath}'`],
    { timeout: 15_000 },
  );
  if (!existsSync(exePath)) throw new Error(`Failed to compile picker: ${stderr}`);
  unlink(csPath).catch(() => {});
  pickerExePath = exePath;
  return exePath;
}

async function execPickDirectoryWindows(): Promise<PickDirectoryResult> {
  try {
    const exe = await ensurePickerExe();
    const { stdout } = await execFileAsync(exe, [], { timeout: 120_000 });
    const result = stdout.trim();
    if (!result || result === '::CANCELLED::') return { status: 'cancelled' };
    const s = await stat(result);
    if (!s.isDirectory()) return { status: 'error', message: 'Selected path is not a directory' };
    return { status: 'picked', path: result };
  } catch (err: unknown) {
    const stderr = String((err as { stderr?: unknown }).stderr ?? '');
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

  // POST /api/projects/pick-directory - open native folder picker (macOS/Windows)
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
    const expandedPrefix = prefix.startsWith('~/') ? homedir() + prefix.slice(1) : prefix;
    const absPrefix = resolve(cwd, expandedPrefix);

    // Split into parent directory + name fragment
    const parentDir = prefix.endsWith('/') ? absPrefix : dirname(absPrefix);
    const fragment = prefix.endsWith('/') ? '' : basename(absPrefix);

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
      const parentParts = validatedPath.split('/');
      parentParts.pop();
      const parent = parentParts.length > 0 ? parentParts.join('/') || '/' : null;
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
