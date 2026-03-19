import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { win32 } from 'node:path';

const IS_WINDOWS = process.platform === 'win32';

let cachedGitBashPath: string | undefined | null;

function isWindowsSystemBash(candidate: string): boolean {
  const normalized = win32.normalize(candidate).toLowerCase();
  return normalized.endsWith('\\system32\\bash.exe');
}

export function pickGitBashPathFromWhere(whereOutput: string, pathExists = existsSync): string | undefined {
  const existingCandidates: string[] = [];
  for (const rawLine of whereOutput.split(/\r?\n/)) {
    const candidate = rawLine.trim().replace(/^"+|"+$/g, '');
    if (!candidate) continue;
    if (win32.basename(candidate).toLowerCase() !== 'bash.exe') continue;
    if (!pathExists(candidate)) continue;
    existingCandidates.push(candidate);
  }

  for (const candidate of existingCandidates) {
    if (!isWindowsSystemBash(candidate)) {
      return candidate;
    }
  }

  return undefined;
}

export function findGitBashPath(): string | undefined {
  if (!IS_WINDOWS) return undefined;
  if (cachedGitBashPath !== undefined) return cachedGitBashPath ?? undefined;

  const standardPath = 'C:\\Program Files\\Git\\bin\\bash.exe';
  if (existsSync(standardPath)) {
    cachedGitBashPath = standardPath;
    return standardPath;
  }

  try {
    const whereOutput = execSync('where bash', { encoding: 'utf-8', timeout: 5000 }).trim();
    const discoveredPath = pickGitBashPathFromWhere(whereOutput);
    if (discoveredPath) {
      cachedGitBashPath = discoveredPath;
      return discoveredPath;
    }
  } catch {
    // `where` failed
  }

  cachedGitBashPath = null;
  return undefined;
}
