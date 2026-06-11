/**
 * Drift Helpers — snapshot utilities and independent helpers for drift resolution.
 * Extracted from drift-resolver.ts to stay within the 350-line file size limit.
 */

import { randomUUID } from 'node:crypto';
import { lstat, readlink, rename, rm, symlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { MountRules } from '@cat-cafe/shared';
import { readCapabilitiesConfig, writeCapabilitiesConfig } from '../config/capabilities/capability-orchestrator.js';
import { markDriftIgnored } from '../config/mount/project-state-store.js';
import { isManagedDirectoryLevelSkillsSymlink } from '../utils/skill-mount.js';
import type { SkillMountPathInput } from '../utils/skill-mount-policy.js';
import { type DriftResult, detectDrift } from './drift-detector.js';

// ─── Types ────────────────────────────────────────────────────

export type ConflictChoice = 'override' | 'skip';

export interface DriftSyncReport {
  /** Skills successfully mounted (newSkills + overridden conflicts). */
  mounted: string[];
  /** Skills whose symlinks were removed (stale set). */
  unmounted: string[];
  /** Conflicts the user chose 'override' for — local path was deleted + symlink created. */
  overridden: string[];
  /** Conflicts the user chose 'skip' for — left alone. */
  skipped: string[];
  /** The drift snapshot used for this sync (post-sync state will be different). */
  resolvedFrom: DriftResult;
}

export interface DriftIgnoreReport {
  /** The driftHash that is now ignored. */
  ignoredHash: string;
  /** The drift snapshot at ignore time. */
  ignoredSnapshot: DriftResult;
}

// ─── Snapshot Types & Utilities ───────────────────────────────

export type PathSnapshot =
  | { kind: 'missing' }
  | { kind: 'symlink'; target: string }
  | { kind: 'moved'; backupPath: string };

export async function snapshotMutablePath(path: string): Promise<PathSnapshot> {
  try {
    const stat = await lstat(path);
    if (stat.isSymbolicLink()) return { kind: 'symlink', target: await readlink(path) };
    const backupPath = join(dirname(path), `.cat-cafe-drift-rollback-${randomUUID()}`);
    await rename(path, backupPath);
    return { kind: 'moved', backupPath };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'missing' };
    throw err;
  }
}

export async function snapshotSymlinkOnly(path: string): Promise<PathSnapshot | null> {
  try {
    const stat = await lstat(path);
    if (!stat.isSymbolicLink()) return null;
    return { kind: 'symlink', target: await readlink(path) };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

export async function restoreMutablePath(path: string, snapshot: PathSnapshot): Promise<void> {
  await rm(path, { recursive: true, force: true });
  if (snapshot.kind === 'symlink') {
    await symlink(snapshot.target, path);
    return;
  }
  if (snapshot.kind === 'moved') {
    await rename(snapshot.backupPath, path);
  }
}

export async function discardMutablePath(snapshot: PathSnapshot): Promise<void> {
  if (snapshot.kind === 'moved') {
    await rm(snapshot.backupPath, { recursive: true, force: true });
  }
}

// ─── Config Helpers ───────────────────────────────────────────

export async function disablePolicyDisabledCapabilities(projectRoot: string, skillNames: string[]): Promise<void> {
  if (skillNames.length === 0) return;
  const config = await readCapabilitiesConfig(projectRoot);
  if (!config) return;

  const disabledSet = new Set(skillNames);
  let dirty = false;
  for (const cap of config.capabilities) {
    if (cap.type !== 'skill' || cap.source !== 'cat-cafe' || cap.pluginId || !disabledSet.has(cap.id)) continue;
    if (cap.enabled) {
      cap.enabled = false;
      dirty = true;
    }
    if ((cap.mountPaths ?? []).length > 0) {
      cap.mountPaths = [];
      dirty = true;
    }
  }
  if (dirty) await writeCapabilitiesConfig(projectRoot, config);
}

export async function classifyProviderRootForOverride(
  skillsDir: string,
  skillsSource: string,
): Promise<'managed-directory' | 'invalid-symlink' | 'blocking-root' | 'normal'> {
  try {
    if (await isManagedDirectoryLevelSkillsSymlink(skillsDir, skillsSource)) return 'managed-directory';
    const stat = await lstat(skillsDir).catch((err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') return null;
      throw err;
    });
    if (stat && !stat.isDirectory()) return 'blocking-root';
    return 'normal';
  } catch (err) {
    try {
      const stat = await lstat(skillsDir);
      if (stat.isSymbolicLink()) return 'invalid-symlink';
    } catch {
      // Preserve the original helper error; it has the actionable path/source context.
    }
    throw err;
  }
}

// ─── Drift Actions ────────────────────────────────────────────

export async function ignoreDrift(
  projectRoot: string,
  skillsSource: string,
  mountRules: MountRules,
  opts?: { disabledSkills?: Iterable<string>; skillMountPaths?: SkillMountPathInput },
): Promise<DriftIgnoreReport> {
  const drift = await detectDrift(projectRoot, skillsSource, mountRules, opts);
  await markDriftIgnored(projectRoot, drift.driftHash);
  return { ignoredHash: drift.driftHash, ignoredSnapshot: drift };
}
