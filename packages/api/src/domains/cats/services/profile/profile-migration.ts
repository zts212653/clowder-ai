import { randomUUID } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { profileUserRelativePath } from '@cat-cafe/shared/profile-contract';
import {
  assertWithin,
  BACKUP_MANIFEST_NAME,
  type BackupManifest,
  buildMigrationPlan,
  type CandidateWithContent,
  collectLegacySources,
  hashContent,
  MARKER_NAME,
  type MigrationPlan,
  type ProfileMigrationCandidate,
  type ProfileMigrationManifest,
  type RunProfileMigrationOptions,
} from './profile-migration-plan.js';

function atomicWrite(path: string, content: string | Buffer): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmpPath = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    writeFileSync(tmpPath, content, { flag: 'wx' });
    renameSync(tmpPath, path);
  } catch (error) {
    rmSync(tmpPath, { force: true });
    throw error;
  }
}

function migrationIdentity(options: RunProfileMigrationOptions, plan: MigrationPlan): string {
  const stable = JSON.stringify({
    userId: options.userId,
    roots: options.legacyRoots.map((root) => resolve(root)),
    sources: plan.legacySources.map(({ sourcePath, targetPath, sha256 }) => ({ sourcePath, targetPath, sha256 })),
    targets: plan.targetWrites.map(({ targetPath, sha256 }) => ({ targetPath, sha256 })),
  });
  return hashContent(stable).slice(0, 16);
}

function readCommonMarkerBackupDir(legacyRoots: string[], dataDir: string): string | undefined {
  let common: string | undefined;
  for (const rootRaw of legacyRoots) {
    const root = resolve(rootRaw);
    if (!existsSync(root)) continue;
    const markerPath = join(root, MARKER_NAME);
    if (!existsSync(markerPath)) return undefined;
    const parsed = JSON.parse(readFileSync(markerPath, 'utf8')) as { backupDir?: string };
    if (!parsed.backupDir) return undefined;
    const resolvedBackupDir = resolve(parsed.backupDir);
    assertWithin(resolve(dataDir, 'profile-migration-backups'), resolvedBackupDir);
    if (common && resolvedBackupDir !== common) return undefined;
    common = resolvedBackupDir;
  }
  return common;
}

function readAppliedHashes(backupDir?: string): Map<string, string> {
  if (!backupDir) return new Map();
  const manifestPath = join(backupDir, BACKUP_MANIFEST_NAME);
  if (!existsSync(manifestPath)) return new Map();
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as BackupManifest;
  if (manifest.version !== 1) return new Map();
  return new Map(manifest.targets.map((target) => [target.targetPath, target.appliedSha256]));
}

function compactSources(sources: ProfileMigrationCandidate[]): ProfileMigrationCandidate[] {
  return sources.map(({ sourceKind, sourcePath, targetPath, sha256 }) => ({
    sourceKind,
    sourcePath,
    targetPath,
    sha256,
  }));
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

interface RecoveryJournal {
  backupDir: string;
  manifest: BackupManifest;
}

function findRecoverableBackup(options: RunProfileMigrationOptions): RecoveryJournal | undefined {
  const backupRoot = resolve(options.dataDir, 'profile-migration-backups');
  if (!existsSync(backupRoot)) return undefined;
  const currentSources = compactSources(collectLegacySources(options.legacyRoots, options.relationshipKeys));
  const expectedRoots = options.legacyRoots.map((root) => resolve(root));
  const expectedCanonicalProfileDir = resolve(options.dataDir, ...profileUserRelativePath(options.userId).split('/'));
  const candidates: RecoveryJournal[] = [];

  for (const entry of readdirSync(backupRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const backupDir = resolve(backupRoot, entry.name);
    const manifestPath = join(backupDir, BACKUP_MANIFEST_NAME);
    if (!existsSync(manifestPath)) continue;
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as BackupManifest;
    if (
      manifest.version !== 1 ||
      manifest.userId !== options.userId ||
      resolve(manifest.canonicalProfileDir) !== expectedCanonicalProfileDir ||
      !sameJson(manifest.legacyRoots, expectedRoots) ||
      !manifest.migration ||
      !sameJson(
        compactSources(manifest.migration.sources.filter((source) => source.sourceKind === 'legacy')),
        currentSources,
      )
    ) {
      continue;
    }
    const canonicalComplete = manifest.targets.every((target) => {
      const canonicalPath = resolve(manifest.canonicalProfileDir, ...target.targetPath.split('/'));
      assertWithin(manifest.canonicalProfileDir, canonicalPath);
      return existsSync(canonicalPath) && hashContent(readFileSync(canonicalPath)) === target.appliedSha256;
    });
    if (canonicalComplete) candidates.push({ backupDir, manifest });
  }

  if (candidates.length > 1) {
    throw new Error(
      `Ambiguous profile migration recovery journals: ${candidates.map(({ backupDir }) => backupDir).join(', ')}`,
    );
  }
  return candidates[0];
}

function canonicalMatches(plan: MigrationPlan): boolean {
  return plan.targetWrites.every((target) => {
    const path = resolve(plan.manifest.canonicalProfileDir, ...target.targetPath.split('/'));
    return existsSync(path) && hashContent(readFileSync(path)) === target.sha256;
  });
}

function assertLegacySnapshotUnchanged(before: CandidateWithContent[], options: RunProfileMigrationOptions): void {
  const after = collectLegacySources(options.legacyRoots, options.relationshipKeys);
  const compact = (sources: CandidateWithContent[]) =>
    sources.map(({ sourcePath, targetPath, sha256 }) => ({ sourcePath, targetPath, sha256 }));
  if (JSON.stringify(compact(before)) !== JSON.stringify(compact(after))) {
    throw new Error('Legacy profile sources changed after planning; refusing stale migration apply');
  }
}

function backupTargets(plan: MigrationPlan, backupDir: string): BackupManifest['targets'] {
  return plan.targetWrites.map((target) => {
    const canonicalPath = resolve(plan.manifest.canonicalProfileDir, ...target.targetPath.split('/'));
    assertWithin(plan.manifest.canonicalProfileDir, canonicalPath);
    const existedBefore = existsSync(canonicalPath);
    const beforeContent = existedBefore ? readFileSync(canonicalPath) : undefined;
    if (beforeContent) {
      const backupPath = join(backupDir, 'canonical-before', ...target.targetPath.split('/'));
      mkdirSync(dirname(backupPath), { recursive: true });
      writeFileSync(backupPath, beforeContent);
    }
    return {
      targetPath: target.targetPath,
      appliedSha256: target.sha256,
      existedBefore,
      ...(beforeContent ? { beforeSha256: hashContent(beforeContent) } : {}),
    };
  });
}

function writeMarkers(options: RunProfileMigrationOptions, canonicalProfileDir: string, backupDir: string): void {
  const markerPaths = options.legacyRoots
    .map((root) => resolve(root, MARKER_NAME))
    .filter((markerPath) => existsSync(dirname(markerPath)));
  markerPaths.forEach((markerPath, index) => {
    options.beforeMarkerWrite?.(markerPath, index);
    atomicWrite(
      markerPath,
      `${JSON.stringify(
        {
          version: 1,
          canonicalProfileDir,
          backupDir,
          migrationId: basename(backupDir),
        },
        null,
        2,
      )}\n`,
    );
  });
}

function applyPlan(options: RunProfileMigrationOptions, plan: MigrationPlan): ProfileMigrationManifest {
  const backupDir = resolve(options.dataDir, 'profile-migration-backups', migrationIdentity(options, plan));
  mkdirSync(backupDir, { recursive: true });
  options.legacyRoots.forEach((legacyRootRaw, index) => {
    const legacyRoot = resolve(legacyRootRaw);
    if (existsSync(legacyRoot)) {
      cpSync(legacyRoot, join(backupDir, `legacy-${index}`), { recursive: true, force: true });
    }
  });

  const markerPaths = options.legacyRoots
    .map((root) => resolve(root, MARKER_NAME))
    .filter((markerPath) => existsSync(dirname(markerPath)));
  const backupManifest: BackupManifest = {
    version: 1,
    userId: options.userId,
    canonicalProfileDir: plan.manifest.canonicalProfileDir,
    legacyRoots: options.legacyRoots.map((root) => resolve(root)),
    markerPaths,
    migration: plan.manifest,
    targets: backupTargets(plan, backupDir),
  };
  atomicWrite(join(backupDir, BACKUP_MANIFEST_NAME), `${JSON.stringify(backupManifest, null, 2)}\n`);

  for (const target of plan.targetWrites) {
    atomicWrite(resolve(plan.manifest.canonicalProfileDir, ...target.targetPath.split('/')), target.content);
  }
  writeMarkers(options, plan.manifest.canonicalProfileDir, backupDir);
  return { ...plan.manifest, status: 'applied', backupDir };
}

export function runProfileMigration(options: RunProfileMigrationOptions): ProfileMigrationManifest {
  if (options.legacyRoots.length === 0) throw new Error('At least one --legacy-root is required');
  const markerBackupDir = readCommonMarkerBackupDir(options.legacyRoots, options.dataDir);
  if (options.apply && !markerBackupDir) {
    const recovery = findRecoverableBackup(options);
    if (recovery) {
      writeMarkers(options, recovery.manifest.canonicalProfileDir, recovery.backupDir);
      return {
        ...recovery.manifest.migration,
        mode: 'apply',
        status: 'noop',
        backupDir: recovery.backupDir,
      };
    }
  }
  const plan = buildMigrationPlan(options, readAppliedHashes(markerBackupDir));
  if (!options.apply) return plan.manifest;
  if (plan.manifest.status === 'blocked') {
    throw new Error(
      `Unresolved profile migration conflicts: ${plan.manifest.conflicts
        .filter((conflict) => !conflict.resolved)
        .map((conflict) => conflict.targetPath)
        .join(', ')}`,
    );
  }
  if (markerBackupDir && canonicalMatches(plan)) {
    return { ...plan.manifest, status: 'noop', backupDir: markerBackupDir };
  }

  options.beforeApply?.();
  assertLegacySnapshotUnchanged(plan.legacySources, options);
  return applyPlan(options, plan);
}

export function rollbackProfileMigration(backupDirRaw: string): { status: 'rolled-back'; backupDir: string } {
  const backupDir = resolve(backupDirRaw);
  const manifestPath = join(backupDir, BACKUP_MANIFEST_NAME);
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as BackupManifest;
  if (manifest.version !== 1) throw new Error(`Unsupported profile migration backup manifest: ${manifestPath}`);

  for (const target of manifest.targets) {
    const canonicalPath = resolve(manifest.canonicalProfileDir, ...target.targetPath.split('/'));
    assertWithin(manifest.canonicalProfileDir, canonicalPath);
    if (!existsSync(canonicalPath) || hashContent(readFileSync(canonicalPath)) !== target.appliedSha256) {
      throw new Error(`Canonical content changed after migration: ${target.targetPath}; refusing rollback overwrite`);
    }
  }

  for (const target of manifest.targets) {
    const canonicalPath = resolve(manifest.canonicalProfileDir, ...target.targetPath.split('/'));
    if (target.existedBefore) {
      const backupPath = join(backupDir, 'canonical-before', ...target.targetPath.split('/'));
      const beforeContent = readFileSync(backupPath);
      if (target.beforeSha256 && hashContent(beforeContent) !== target.beforeSha256) {
        throw new Error(`Backup hash mismatch for ${target.targetPath}; refusing rollback`);
      }
      atomicWrite(canonicalPath, beforeContent);
    } else {
      rmSync(canonicalPath, { force: true });
    }
  }
  for (const markerPath of manifest.markerPaths) rmSync(markerPath, { force: true });
  return { status: 'rolled-back', backupDir };
}

export type { ProfileMigrationManifest, RunProfileMigrationOptions } from './profile-migration-plan.js';
export { hashContent } from './profile-migration-plan.js';
