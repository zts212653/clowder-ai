import { lstat, readFile, realpath } from 'node:fs/promises';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { isUnderAllowedRoot } from '../utils/project-path.js';

async function realpathOrNull(path: string): Promise<string | null> {
  try {
    return await realpath(path);
  } catch {
    return null;
  }
}

function realpathSyncOrNull(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

function normalizePathForCompare(path: string): string {
  const trimmed = path.replace(/[\\/]+$/g, '');
  return process.platform === 'win32' ? trimmed.toLowerCase() : trimmed;
}

function samePath(left: string, right: string): boolean {
  return normalizePathForCompare(left) === normalizePathForCompare(right);
}

function parseGitdirPointer(raw: string): string | null {
  const firstLine = raw.split(/\r?\n/, 1)[0]?.trim() ?? '';
  if (!firstLine.toLowerCase().startsWith('gitdir:')) return null;
  const value = firstLine.slice('gitdir:'.length).trim();
  return value.length > 0 ? value : null;
}

function parsePathPointer(raw: string): string | null {
  const firstLine = raw.split(/\r?\n/, 1)[0]?.trim() ?? '';
  if (!firstLine) return null;
  if (firstLine.toLowerCase().startsWith('gitdir:')) {
    const value = firstLine.slice('gitdir:'.length).trim();
    return value.length > 0 ? value : null;
  }
  return firstLine;
}

async function resolveGitdirPointer(filePath: string, baseDir: string): Promise<string | null> {
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf-8');
  } catch {
    return null;
  }
  const pointer = parseGitdirPointer(raw);
  if (!pointer) return null;
  return realpathOrNull(resolve(baseDir, pointer));
}

async function resolvePathPointer(filePath: string, baseDir: string): Promise<string | null> {
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf-8');
  } catch {
    return null;
  }
  const pointer = parsePathPointer(raw);
  if (!pointer) return null;
  return realpathOrNull(resolve(baseDir, pointer));
}

function resolveGitdirPointerSync(filePath: string, baseDir: string): string | null {
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }
  const pointer = parseGitdirPointer(raw);
  if (!pointer) return null;
  return realpathSyncOrNull(resolve(baseDir, pointer));
}

function resolvePathPointerSync(filePath: string, baseDir: string): string | null {
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }
  const pointer = parsePathPointer(raw);
  if (!pointer) return null;
  return realpathSyncOrNull(resolve(baseDir, pointer));
}

export function isAllowedProviderProfilesRoot(absPath: string): boolean {
  return isUnderAllowedRoot(absPath);
}

export async function resolveProviderProfilesRoot(projectRoot: string): Promise<string> {
  const root = resolve(projectRoot);
  const rootReal = (await realpathOrNull(root)) ?? root;
  const gitPath = resolve(rootReal, '.git');
  try {
    const st = await lstat(gitPath);
    if (st.isDirectory()) return rootReal;
    if (!st.isFile()) return rootReal;

    const gitDir = await resolveGitdirPointer(gitPath, rootReal);
    if (!gitDir) return rootReal;

    const worktreesDir = dirname(gitDir);
    if (basename(worktreesDir) !== 'worktrees') return rootReal;
    const commonGitDir = dirname(worktreesDir);
    if (basename(commonGitDir) !== '.git') return rootReal;

    // Security: verify this is a legitimate git worktree registration.
    const backRef = await resolvePathPointer(resolve(gitDir, 'gitdir'), gitDir);
    if (!backRef || !samePath(backRef, gitPath)) return rootReal;

    let commondirRaw: string;
    try {
      commondirRaw = await readFile(resolve(gitDir, 'commondir'), 'utf-8');
    } catch {
      return rootReal;
    }
    const commondirValue = commondirRaw.split(/\r?\n/, 1)[0]?.trim();
    if (!commondirValue) return rootReal;
    const commondirResolved = await realpathOrNull(resolve(gitDir, commondirValue));
    if (!commondirResolved || !samePath(commondirResolved, commonGitDir)) return rootReal;

    const candidateRoot = dirname(commonGitDir);
    if (!isAllowedProviderProfilesRoot(candidateRoot)) return rootReal;
    return candidateRoot;
  } catch {
    return rootReal;
  }
}

export function resolveProviderProfilesRootSync(projectRoot: string): string {
  const root = resolve(projectRoot);
  const rootReal = realpathSyncOrNull(root) ?? root;
  const gitPath = resolve(rootReal, '.git');
  try {
    const st = lstatSync(gitPath);
    if (st.isDirectory()) return rootReal;
    if (!st.isFile()) return rootReal;

    const gitDir = resolveGitdirPointerSync(gitPath, rootReal);
    if (!gitDir) return rootReal;

    const worktreesDir = dirname(gitDir);
    if (basename(worktreesDir) !== 'worktrees') return rootReal;
    const commonGitDir = dirname(worktreesDir);
    if (basename(commonGitDir) !== '.git') return rootReal;

    const backRef = resolvePathPointerSync(resolve(gitDir, 'gitdir'), gitDir);
    if (!backRef || !samePath(backRef, gitPath)) return rootReal;

    let commondirRaw: string;
    try {
      commondirRaw = readFileSync(resolve(gitDir, 'commondir'), 'utf-8');
    } catch {
      return rootReal;
    }
    const commondirValue = commondirRaw.split(/\r?\n/, 1)[0]?.trim();
    if (!commondirValue) return rootReal;
    const commondirResolved = realpathSyncOrNull(resolve(gitDir, commondirValue));
    if (!commondirResolved || !samePath(commondirResolved, commonGitDir)) return rootReal;

    const candidateRoot = dirname(commonGitDir);
    if (!isAllowedProviderProfilesRoot(candidateRoot)) return rootReal;
    return candidateRoot;
  } catch {
    return rootReal;
  }
}
