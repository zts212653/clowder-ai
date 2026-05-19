/**
 * ADR-025 Phase 2: Skill Sync Service
 *
 * Creates/updates per-skill symlinks for all 4 providers (project-level)
 * and writes skills-state.json. This is the TypeScript equivalent of
 * the project-level portion of scripts/sync-skills.sh.
 */

import { lstat, mkdir, readlink, realpath, rm, symlink } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';

import { computeSourceManifestHash, listSourceSkillNames, readSkillsState, writeSkillsState } from './skills-state.js';

const PROVIDER_DIRS = ['.claude/skills', '.codex/skills', '.gemini/skills', '.kimi/skills'];

/** Safe skill name: lowercase letters, digits, hyphens. No path separators, dots-only, or absolute paths. */
const VALID_SKILL_NAME = /^[a-z][a-z0-9-]*$/;

export function validateSkillName(name: string): void {
  if (!VALID_SKILL_NAME.test(name)) {
    throw new Error(`Invalid skill name: "${name}". Must match ${VALID_SKILL_NAME}.`);
  }
}

export interface SkillsSyncResult {
  synced: string[];
  removed: string[];
  newHash: string;
}

async function ensureCorrectSymlink(linkPath: string, target: string): Promise<void> {
  try {
    const s = await lstat(linkPath);
    if (s.isSymbolicLink()) {
      const existing = await readlink(linkPath);
      if (existing === target) return;
      await rm(linkPath);
    } else {
      // Non-symlink (real dir/file) at a managed skill path — replace it (#327).
      // Without this, sync silently skips → governance re-offers → confirm loop.
      await rm(linkPath, { recursive: true });
    }
  } catch {
    // Doesn't exist — fine, we'll create it
  }
  await symlink(target, linkPath);
}

async function removeSymlinkIfExists(linkPath: string): Promise<void> {
  try {
    const s = await lstat(linkPath);
    if (s.isSymbolicLink()) await rm(linkPath);
  } catch {
    // Doesn't exist — nothing to remove
  }
}

async function shouldSkipDirectoryLevelSkillsSymlink(skillsDir: string, skillsSource: string): Promise<boolean> {
  try {
    if (!(await lstat(skillsDir)).isSymbolicLink()) return false;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }

  let mountedRoot: string;
  let expectedRoot: string;
  try {
    mountedRoot = await realpath(skillsDir);
    expectedRoot = await realpath(skillsSource);
  } catch (err) {
    throw new Error(
      `Invalid directory-level skills mount at ${skillsDir}: symlink must resolve to the current skills source ${skillsSource}. ${
        (err as Error).message
      }`,
    );
  }

  if (mountedRoot !== expectedRoot) {
    throw new Error(
      `Invalid directory-level skills mount at ${skillsDir}: resolves to ${mountedRoot}, expected ${expectedRoot}.`,
    );
  }
  return true;
}

function symlinkTargetFor(linkPath: string, sourcePath: string): string {
  return process.platform === 'win32' ? sourcePath : relative(dirname(linkPath), sourcePath);
}

/**
 * Sync per-skill symlinks for all 4 providers and update skills-state.json.
 *
 * - Creates symlinks: `{projectRoot}/.{provider}/skills/{skillName}` → `{skillsSource}/{skillName}`
 * - Removes stale symlinks for skills no longer in source
 * - Updates `.cat-cafe/skills-state.json`
 */
export async function syncSkills(projectRoot: string, skillsSource: string): Promise<SkillsSyncResult> {
  const currentNames = await listSourceSkillNames(skillsSource);
  const previousState = await readSkillsState(projectRoot);
  const previousNames = previousState?.managedSkillNames ?? [];

  // Determine stale skills (in previous state but no longer in source)
  const currentSet = new Set(currentNames);
  const removed = previousNames.filter((n) => !currentSet.has(n));

  // Create/update symlinks for current skills
  for (const providerDir of PROVIDER_DIRS) {
    const skillsDir = join(projectRoot, providerDir);
    if (await shouldSkipDirectoryLevelSkillsSymlink(skillsDir, skillsSource)) {
      // Legacy directory-level mounts are already valid. Do not follow the
      // symlink and write per-skill links back into the source skills tree.
      continue;
    }
    await mkdir(skillsDir, { recursive: true });

    for (const skillName of currentNames) {
      const linkPath = join(skillsDir, skillName);
      const target = symlinkTargetFor(linkPath, join(skillsSource, skillName));
      await ensureCorrectSymlink(linkPath, target);
    }

    // Remove stale symlinks
    for (const skillName of removed) {
      await removeSymlinkIfExists(join(skillsDir, skillName));
    }
  }

  // Update skills-state.json
  const newHash = await computeSourceManifestHash(skillsSource);
  const sourceRoot = relative(projectRoot, skillsSource);
  await writeSkillsState(projectRoot, {
    managedSkillNames: currentNames,
    sourceRoot,
    sourceManifestHash: newHash,
    lastSyncedAt: new Date().toISOString(),
  });

  return {
    synced: currentNames,
    removed,
    newHash,
  };
}

/**
 * Resolve a single skill conflict between user-level and project-level.
 *
 * - 'official' → remove user-level symlinks (project/official version wins)
 * - 'mine' → remove project-level symlinks + remove from managed set (user version wins)
 */
export async function resolveConflict(
  projectRoot: string,
  homeDir: string,
  skillName: string,
  choice: 'official' | 'mine',
): Promise<void> {
  validateSkillName(skillName);

  if (choice !== 'official' && choice !== 'mine') {
    throw new Error(`Invalid choice: ${choice}. Must be 'official' or 'mine'.`);
  }

  for (const providerDir of PROVIDER_DIRS) {
    if (choice === 'official') {
      // Remove user-level symlink — project (official) version wins
      await removeSymlinkIfExists(join(homeDir, providerDir, skillName));
    } else {
      // Remove project-level symlink — user version wins
      await removeSymlinkIfExists(join(projectRoot, providerDir, skillName));
    }
  }

  // If 'mine': also remove skill from managed set in skills-state.json
  if (choice === 'mine') {
    const state = await readSkillsState(projectRoot);
    if (state) {
      await writeSkillsState(projectRoot, {
        ...state,
        managedSkillNames: state.managedSkillNames.filter((n) => n !== skillName),
        lastSyncedAt: new Date().toISOString(),
      });
    }
  }
}
