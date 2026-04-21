import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';

function isWindowsSystemBash(candidate) {
  return candidate.replace(/\//g, '\\').toLowerCase().endsWith('\\windows\\system32\\bash.exe');
}

export function pickGitBashPathFromWhere(whereOutput, pathExists = existsSync) {
  const existingCandidates = [];
  for (const rawLine of whereOutput.split(/\r?\n/)) {
    const candidate = rawLine.trim().replace(/^"+|"+$/g, '');
    if (!candidate) continue;
    if (!candidate.toLowerCase().endsWith('bash.exe')) continue;
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

function defaultExecWhere() {
  return execSync('where bash', { encoding: 'utf8', timeout: 5000 }).trim();
}

export function resolveBashCommand({
  platform = process.platform,
  standardPath = 'C:\\Program Files\\Git\\bin\\bash.exe',
  pathExists = existsSync,
  execWhere = defaultExecWhere,
} = {}) {
  if (platform !== 'win32') {
    return 'bash';
  }

  if (pathExists(standardPath)) {
    return standardPath;
  }

  try {
    const whereOutput = execWhere();
    return pickGitBashPathFromWhere(whereOutput, pathExists);
  } catch {
    return undefined;
  }
}

export function requireBash(t, options) {
  const bash = resolveBashCommand(options);
  if (!bash) {
    t.skip('bash is unavailable on this platform');
  }
  return bash;
}
