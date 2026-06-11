/**
 * Skill Symlink Writer — F228 / Issue #719
 *
 * Atomic mount/unmount of a single skill into all active mount targets
 * under `projectRoot`. Used by the capabilities PATCH route to keep
 * provider/custom `{skillsDir}/{skillName}` symlinks in sync with the
 * `enabled` flag in capabilities.json.
 */

import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readlink, realpath, rename, rm, symlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { type MountRules, STANDARD_PROVIDER_IDS, type StandardProviderId } from '@cat-cafe/shared';
import { ensureCorrectSymlink } from '../config/governance/skill-sync.js';
import { pathsEqual } from './project-path.js';
import { buildProjectSkillMountDirs, isManagedDirectoryLevelSkillsSymlink } from './skill-mount.js';

export interface SkillMountResult {
  /** Absolute paths where symlinks were created (or already correct). */
  mounted: string[];
}

export interface SkillUnmountResult {
  /** Absolute paths where symlinks were removed (already-absent paths are not listed). */
  unmounted: string[];
}

export type LinkSnapshot =
  | { kind: 'missing' }
  | { kind: 'symlink'; target: string }
  | { kind: 'moved'; backupPath: string };

export interface SkillMountSnapshot {
  entries: Array<{ linkPath: string; snapshot: LinkSnapshot }>;
}

function symlinkTargetFor(linkPath: string, sourcePath: string): string {
  return process.platform === 'win32' ? sourcePath : relative(dirname(linkPath), sourcePath);
}

/**
 * F228: Create a MountRules clone that only contains the specified provider.
 * Standard providers: all others disabled. Custom: all others removed.
 * This lets existing mount/unmount functions operate on a single provider
 * without duplicating their symlink/rollback/managed-directory logic.
 */
export function filterRulesToProvider(rules: MountRules, providerId: string): MountRules {
  const filtered = structuredClone(rules);
  const standardSet = new Set<string>(STANDARD_PROVIDER_IDS);
  if (standardSet.has(providerId)) {
    for (const id of STANDARD_PROVIDER_IDS) {
      if (id !== providerId) filtered.providers[id as StandardProviderId].enabled = false;
    }
    filtered.customPaths = [];
  } else {
    for (const id of STANDARD_PROVIDER_IDS) {
      filtered.providers[id as StandardProviderId].enabled = false;
    }
    filtered.customPaths = (rules.customPaths ?? []).filter((cp) => cp.alias === providerId);
  }
  return filtered;
}

function mountSkillDirsForRules(projectRoot: string, rules: MountRules): string[] {
  return buildProjectSkillMountDirs(projectRoot, homedir(), rules);
}

function unmountSkillDirsForRules(projectRoot: string, rules: MountRules, opts?: { enabledOnly?: boolean }): string[] {
  return buildProjectSkillMountDirs(projectRoot, homedir(), rules, {
    includeDisabledStandardProviders: !opts?.enabledOnly,
  });
}

async function snapshotLink(linkPath: string): Promise<LinkSnapshot> {
  try {
    const stat = await lstat(linkPath);
    if (stat.isSymbolicLink()) return { kind: 'symlink', target: await readlink(linkPath) };
    const backupPath = join(dirname(linkPath), `.cat-cafe-rollback-${randomUUID()}`);
    await rename(linkPath, backupPath);
    return { kind: 'moved', backupPath };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'missing' };
    throw err;
  }
}

async function snapshotSymlinkOnly(linkPath: string): Promise<LinkSnapshot | null> {
  try {
    const stat = await lstat(linkPath);
    if (!stat.isSymbolicLink()) return null;
    return { kind: 'symlink', target: await readlink(linkPath) };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

async function snapshotMissingOrSymlink(linkPath: string): Promise<LinkSnapshot | null> {
  try {
    const stat = await lstat(linkPath);
    if (!stat.isSymbolicLink()) return null;
    return { kind: 'symlink', target: await readlink(linkPath) };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'missing' };
    throw err;
  }
}

async function pathIsManagedSkillSymlink(linkPath: string, skillsSource: string, skillName: string): Promise<boolean> {
  let target: string;
  try {
    const stat = await lstat(linkPath);
    if (!stat.isSymbolicLink()) return false;
    target = await readlink(linkPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }

  const absoluteTarget = resolve(dirname(linkPath), target);
  const expectedTarget = resolve(skillsSource, skillName);
  if (pathsEqual(absoluteTarget, expectedTarget)) return true;

  const [realTarget, realExpected] = await Promise.all([
    realpath(absoluteTarget).catch(() => absoluteTarget),
    realpath(expectedTarget).catch(() => expectedTarget),
  ]);
  return pathsEqual(realTarget, realExpected);
}

async function classifyExistingMountPath(
  linkPath: string,
  skillsSource: string,
  skillName: string,
): Promise<'missing' | 'managed' | 'conflict'> {
  try {
    const stat = await lstat(linkPath);
    if (stat.isSymbolicLink() && (await pathIsManagedSkillSymlink(linkPath, skillsSource, skillName))) {
      return 'managed';
    }
    return 'conflict';
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 'missing';
    throw err;
  }
}

function buildMountConflictError(linkPath: string, skillName: string): Error {
  return new Error(
    `Refusing to mount skill "${skillName}" at ${linkPath}: path already exists and is not a managed Cat Cafe skill symlink.`,
  );
}

async function restoreLinkSnapshot(linkPath: string, snapshot: LinkSnapshot): Promise<void> {
  await rm(linkPath, { recursive: true, force: true });
  if (snapshot.kind === 'symlink') {
    await symlink(snapshot.target, linkPath);
    return;
  }
  if (snapshot.kind === 'moved') {
    await rename(snapshot.backupPath, linkPath);
  }
}

async function discardLinkSnapshot(snapshot: LinkSnapshot): Promise<void> {
  if (snapshot.kind === 'moved') {
    await rm(snapshot.backupPath, { recursive: true, force: true });
  }
}

export async function snapshotSkillMountsForProject(
  projectRoot: string,
  skillName: string,
  skillsSource: string,
  rules: MountRules,
  opts?: {
    enabledOnly?: boolean;
    symlinksOnly?: boolean;
    preserveNonSymlinks?: boolean;
    includeManagedDirectoryRoots?: boolean;
  },
): Promise<SkillMountSnapshot> {
  const entries: SkillMountSnapshot['entries'] = [];
  try {
    for (const skillsDir of unmountSkillDirsForRules(projectRoot, rules, { enabledOnly: opts?.enabledOnly })) {
      if (await isManagedDirectoryLevelSkillsSymlink(skillsDir, skillsSource)) {
        if (opts?.includeManagedDirectoryRoots) {
          const snapshot = await snapshotSymlinkOnly(skillsDir);
          if (snapshot) entries.push({ linkPath: skillsDir, snapshot });
        }
        continue;
      }
      const linkPath = join(skillsDir, skillName);
      const snapshot = opts?.symlinksOnly
        ? await snapshotSymlinkOnly(linkPath)
        : opts?.preserveNonSymlinks
          ? await snapshotMissingOrSymlink(linkPath)
          : await snapshotLink(linkPath);
      if (snapshot) entries.push({ linkPath, snapshot });
    }
    return { entries };
  } catch (err) {
    for (const entry of entries.reverse()) {
      await restoreLinkSnapshot(entry.linkPath, entry.snapshot).catch(() => {});
    }
    throw err;
  }
}

export async function restoreSkillMountSnapshot(snapshot: SkillMountSnapshot): Promise<void> {
  for (const entry of snapshot.entries.slice().reverse()) {
    await restoreLinkSnapshot(entry.linkPath, entry.snapshot);
  }
}

export async function discardSkillMountSnapshot(snapshot: SkillMountSnapshot): Promise<void> {
  for (const entry of snapshot.entries) {
    await discardLinkSnapshot(entry.snapshot);
  }
}

export async function convertManagedDirectoryLevelSkillMountsForProject(
  projectRoot: string,
  skillsSource: string,
  rules: MountRules,
  skillNames: string[],
): Promise<{ converted: string[] }> {
  return convertManagedDirectoryLevelSkillMountsForPolicy(
    projectRoot,
    skillsSource,
    rules,
    mountTargetIdsForRules(rules),
    () => skillNames,
  );
}

function mountTargetIdsForRules(rules: MountRules): string[] {
  return [
    ...STANDARD_PROVIDER_IDS.filter((id) => rules.providers[id].enabled),
    ...(rules.customPaths ?? []).map((cp) => cp.alias),
  ];
}

async function isManagedDirectoryLevelMountForConversion(skillsDir: string, skillsSource: string): Promise<boolean> {
  try {
    const stat = await lstat(skillsDir);
    if (!stat.isSymbolicLink()) return false;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }

  const expectedRoot = await realpath(skillsSource);
  const mountedRoot = await realpath(skillsDir).catch(() => null);
  return mountedRoot ? pathsEqual(mountedRoot, expectedRoot) : false;
}

export async function convertManagedDirectoryLevelSkillMountsForPolicy(
  projectRoot: string,
  skillsSource: string,
  rules: MountRules,
  providerIds: readonly string[],
  skillNamesForProvider: (providerId: string) => Promise<readonly string[]> | readonly string[],
  opts?: { beforeConvert?: (skillsDir: string) => Promise<void> },
): Promise<{ converted: string[] }> {
  const converted: string[] = [];
  for (const providerId of providerIds) {
    const providerRules = filterRulesToProvider(rules, providerId);
    const skillNames = await skillNamesForProvider(providerId);
    for (const skillsDir of mountSkillDirsForRules(projectRoot, providerRules)) {
      if (!(await isManagedDirectoryLevelMountForConversion(skillsDir, skillsSource))) continue;

      await opts?.beforeConvert?.(skillsDir);
      await rm(skillsDir);
      await mkdir(skillsDir, { recursive: true });
      for (const skillName of skillNames) {
        const linkPath = join(skillsDir, skillName);
        await symlink(symlinkTargetFor(linkPath, join(skillsSource, skillName)), linkPath);
      }
      converted.push(skillsDir);
    }
  }
  return { converted };
}

/**
 * Create `{skillsDir}/{skillName}` → `{skillsSource}/{skillName}` symlinks for
 * every enabled standard provider and every configured custom path.
 * Idempotent: already-managed symlinks are left alone; same-name user paths are
 * rejected so the drift conflict flow can handle them without deleting local
 * skill content.
 */
export async function mountSkillForProject(
  projectRoot: string,
  skillName: string,
  skillsSource: string,
  rules: MountRules,
): Promise<SkillMountResult> {
  const mounted: string[] = [];
  const rollback: Array<{ linkPath: string; snapshot: LinkSnapshot }> = [];
  try {
    for (const skillsDir of mountSkillDirsForRules(projectRoot, rules)) {
      const linkPath = join(skillsDir, skillName);
      if (await isManagedDirectoryLevelSkillsSymlink(skillsDir, skillsSource)) {
        mounted.push(linkPath);
        continue;
      }
      const existing = await classifyExistingMountPath(linkPath, skillsSource, skillName);
      if (existing === 'managed') {
        mounted.push(linkPath);
        continue;
      }
      if (existing === 'conflict') {
        throw buildMountConflictError(linkPath, skillName);
      }
      await mkdir(skillsDir, { recursive: true });
      const target = symlinkTargetFor(linkPath, join(skillsSource, skillName));
      const snapshot = await snapshotLink(linkPath);
      try {
        await ensureCorrectSymlink(linkPath, target);
      } catch (err) {
        await restoreLinkSnapshot(linkPath, snapshot).catch(() => {});
        throw err;
      }
      rollback.push({ linkPath, snapshot });
      mounted.push(linkPath);
    }
    for (const entry of rollback) {
      await discardLinkSnapshot(entry.snapshot).catch(() => {});
    }
    return { mounted };
  } catch (err) {
    for (const entry of rollback.reverse()) {
      await restoreLinkSnapshot(entry.linkPath, entry.snapshot).catch(() => {});
    }
    throw err;
  }
}

/**
 * Remove `{skillsDir}/{skillName}` symlink for every standard provider path
 * in the current rules, including disabled providers, and every custom path.
 * Disabling a provider does not make stale managed symlinks safe to keep:
 * they can become loadable again if that provider is later re-enabled.
 * Idempotent: absent paths are no-ops.
 */
export async function unmountSkillForProject(
  projectRoot: string,
  skillName: string,
  rules: MountRules,
  skillsSource: string,
  opts?: { enabledOnly?: boolean },
): Promise<SkillUnmountResult> {
  const unmounted: string[] = [];
  for (const skillsDir of unmountSkillDirsForRules(projectRoot, rules, { enabledOnly: opts?.enabledOnly })) {
    const linkPath = join(skillsDir, skillName);
    if (!(await pathIsManagedSkillSymlink(linkPath, skillsSource, skillName))) continue;
    try {
      await rm(linkPath);
      unmounted.push(linkPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw err;
    }
  }
  return { unmounted };
}
