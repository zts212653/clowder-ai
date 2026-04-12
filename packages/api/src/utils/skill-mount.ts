import { execFile } from 'node:child_process';
import { lstat, readlink, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { pathsEqual } from './project-path.js';

export type SkillProviderMountKey = 'claude' | 'codex' | 'gemini' | 'kimi';

export function buildProviderSkillDirCandidates(
  projectRoot: string,
  home: string,
): Record<SkillProviderMountKey, string[]> {
  return {
    claude: [...new Set([join(projectRoot, '.claude', 'skills'), join(home, '.claude', 'skills')])],
    codex: [...new Set([join(projectRoot, '.codex', 'skills'), join(home, '.codex', 'skills')])],
    gemini: [...new Set([join(projectRoot, '.gemini', 'skills'), join(home, '.gemini', 'skills')])],
    kimi: [...new Set([join(projectRoot, '.kimi', 'skills'), join(home, '.kimi', 'skills')])],
  };
}

/** Accept symlink target when it points to expected path OR main-repo cat-cafe-skills/{skillName}. */
export async function isCorrectSymlink(
  linkPath: string,
  expectedTarget: string,
  skillName?: string,
  fallbackSkillsRoot?: string,
): Promise<boolean> {
  try {
    const stat = await lstat(linkPath);
    if (!stat.isSymbolicLink()) return false;
    const dest = await readlink(linkPath);
    const absDest = isAbsolute(dest) ? dest : resolve(dirname(linkPath), dest);
    const [realDest, realExpected] = await Promise.all([
      realpath(absDest).catch(() => absDest),
      realpath(expectedTarget).catch(() => expectedTarget),
    ]);
    const normalizedDest = realDest.replace(/[/\\]$/, '');
    const normalizedExpected = realExpected.replace(/[/\\]$/, '');
    if (pathsEqual(normalizedDest, normalizedExpected)) return true;

    if (skillName && fallbackSkillsRoot) {
      const parentDir = dirname(normalizedDest);
      const nameMatches = normalizedDest.endsWith(`${sep}${skillName}`);
      const isCatCafeSkillsDir = basename(parentDir) === 'cat-cafe-skills';
      const resolvedFallbackRoot = (await realpath(fallbackSkillsRoot).catch(() => fallbackSkillsRoot)).replace(
        /[/\\]$/,
        '',
      );
      const inFallbackRoot = pathsEqual(parentDir, resolvedFallbackRoot);
      const hasManifest = await realpath(join(parentDir, 'manifest.yaml'))
        .then(() => true)
        .catch(() => false);
      const hasSkillMd = await realpath(join(normalizedDest, 'SKILL.md'))
        .then(() => true)
        .catch(() => false);
      if (isCatCafeSkillsDir && inFallbackRoot && nameMatches && hasManifest && hasSkillMd) {
        return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}

export async function isSkillMountedForProvider(
  dirCandidates: string[],
  expectedSkillsRoot: string,
  skillName: string,
  fallbackSkillsRoot?: string,
): Promise<boolean> {
  for (const dir of dirCandidates) {
    if (await isCorrectSymlink(dir, expectedSkillsRoot)) return true;
    if (fallbackSkillsRoot && (await isCorrectSymlink(dir, fallbackSkillsRoot))) return true;
    if (
      await isCorrectSymlink(join(dir, skillName), join(expectedSkillsRoot, skillName), skillName, fallbackSkillsRoot)
    ) {
      return true;
    }
  }
  return false;
}

const execFileAsync = promisify(execFile);
let cachedMainRepoPath: string | null = null;
let cachedMainRepoPathPromise: Promise<string> | null = null;

export async function resolveMainRepoPath(): Promise<string> {
  if (cachedMainRepoPath) return cachedMainRepoPath;
  if (cachedMainRepoPathPromise) return cachedMainRepoPathPromise;
  cachedMainRepoPathPromise = (async () => {
    const moduleRepoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
    try {
      const { stdout } = await execFileAsync('git', ['worktree', 'list', '--porcelain']);
      const firstLine = stdout.split('\n')[0] ?? '';
      return firstLine.replace(/^worktree\s+/, '').trim();
    } catch {
      try {
        const { stdout } = await execFileAsync('git', ['rev-parse', '--show-toplevel']);
        return stdout.trim();
      } catch {
        return moduleRepoRoot;
      }
    }
  })().then((p) => {
    cachedMainRepoPath = p;
    return p;
  });
  return cachedMainRepoPathPromise;
}
