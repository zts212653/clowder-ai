import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { profileUserRelativePath, relationshipPrimerRelativePath } from '@cat-cafe/shared/profile-contract';

export const MARKER_NAME = '.migrated-to-cat-cafe-data-dir.json';
export const BACKUP_MANIFEST_NAME = 'migration-backup.json';

type MigrationMode = 'dry-run' | 'apply';
type MigrationStatus = 'ready' | 'blocked' | 'applied' | 'noop';

export interface ProfileMigrationCandidate {
  sourceKind: 'legacy' | 'canonical';
  sourcePath: string;
  targetPath: string;
  sha256: string;
}

export interface ProfileMigrationConflict {
  targetPath: string;
  candidates: ProfileMigrationCandidate[];
  resolved: boolean;
}

export interface ProfileMigrationManifest {
  version: 1;
  mode: MigrationMode;
  status: MigrationStatus;
  userId: string;
  canonicalProfileDir: string;
  sources: ProfileMigrationCandidate[];
  targets: Array<{ targetPath: string; sha256: string }>;
  conflicts: ProfileMigrationConflict[];
  backupDir?: string;
}

export interface CandidateWithContent extends ProfileMigrationCandidate {
  content: Buffer;
}

interface ResolutionEntry {
  contentFile: string;
  expectedSourceHashes: string[];
}

interface ResolutionFile {
  version: 1;
  resolutions: Record<string, ResolutionEntry>;
}

export interface TargetWrite {
  targetPath: string;
  content: Buffer;
  sha256: string;
}

export interface MigrationPlan {
  manifest: ProfileMigrationManifest;
  legacySources: CandidateWithContent[];
  targetWrites: TargetWrite[];
}

export interface BackupManifest {
  version: 1;
  userId: string;
  canonicalProfileDir: string;
  legacyRoots: string[];
  markerPaths: string[];
  /** Durable transaction journal used to finish marker commit after canonical writes. */
  migration: ProfileMigrationManifest;
  targets: Array<{
    targetPath: string;
    appliedSha256: string;
    existedBefore: boolean;
    beforeSha256?: string;
  }>;
}

export interface RunProfileMigrationOptions {
  legacyRoots: string[];
  dataDir: string;
  userId: string;
  relationshipKeys: Record<string, string>;
  resolutionFile?: string;
  apply?: boolean;
  /** Test seam for proving source-drift detection between planning and the first write. */
  beforeApply?: () => void;
  /** Test seam for proving recovery after canonical writes but before marker commit. */
  beforeMarkerWrite?: (markerPath: string, index: number) => void;
}

export function hashContent(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

export function assertWithin(base: string, path: string): void {
  const rel = relative(resolve(base), resolve(path));
  if (rel.startsWith('..') || isAbsolute(rel)) throw new Error(`Path escapes base directory: ${path}`);
}

function readCandidate(
  sourceKind: 'legacy' | 'canonical',
  sourcePath: string,
  targetPath: string,
): CandidateWithContent {
  const content = readFileSync(sourcePath);
  return { sourceKind, sourcePath: resolve(sourcePath), targetPath, sha256: hashContent(content), content };
}

function walkFiles(root: string): string[] {
  if (!existsSync(root)) return [];
  const files: string[] = [];
  for (const dirent of readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(root, dirent.name);
    if (dirent.isSymbolicLink()) {
      throw new Error(`Symbolic link is unsupported in a legacy profile tree: ${path}`);
    }
    if (dirent.isDirectory()) files.push(...walkFiles(path));
    else if (dirent.isFile()) files.push(path);
    else throw new Error(`Unsupported filesystem entry in a legacy profile tree: ${path}`);
  }
  return files;
}

function relationshipKeyForStem(stem: string, relationshipKeys: Record<string, string>): string {
  const direct = relationshipKeys[stem];
  if (direct) return direct;
  if (Object.values(relationshipKeys).includes(stem)) return stem;
  throw new Error(`Unknown legacy relationship primer stem "${stem}"; add an explicit catId → relationshipKey mapping`);
}

export function collectLegacySources(
  legacyRoots: string[],
  relationshipKeys: Record<string, string>,
): CandidateWithContent[] {
  const sources: CandidateWithContent[] = [];
  for (const legacyRootRaw of legacyRoots) {
    const legacyRoot = resolve(legacyRootRaw);
    if (!existsSync(legacyRoot)) continue;

    const capsulePath = join(legacyRoot, 'landy-capsule.md');
    if (existsSync(capsulePath)) sources.push(readCandidate('legacy', capsulePath, 'landy-capsule.md'));

    const relationshipDir = join(legacyRoot, 'relationship');
    for (const primerPath of walkFiles(relationshipDir)) {
      const rel = relative(relationshipDir, primerPath).replaceAll('\\', '/');
      if (rel.includes('/')) throw new Error(`Nested legacy relationship primer is unsupported: ${primerPath}`);
      const match = /^(.*)-primer\.md$/.exec(rel);
      if (!match) continue;
      const relationshipKey = relationshipKeyForStem(match[1], relationshipKeys);
      sources.push(readCandidate('legacy', primerPath, relationshipPrimerRelativePath(relationshipKey)));
    }

    const provenanceDir = join(legacyRoot, 'provenance');
    for (const provenancePath of walkFiles(provenanceDir)) {
      const rel = relative(provenanceDir, provenancePath).replaceAll('\\', '/');
      assertWithin(provenanceDir, provenancePath);
      sources.push(readCandidate('legacy', provenancePath, `provenance/${rel}`));
    }
  }
  return sources.sort((a, b) => a.targetPath.localeCompare(b.targetPath) || a.sourcePath.localeCompare(b.sourcePath));
}

function loadResolutions(path?: string): ResolutionFile | undefined {
  if (!path) return undefined;
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<ResolutionFile>;
  if (parsed.version !== 1 || !parsed.resolutions || typeof parsed.resolutions !== 'object') {
    throw new Error(`Invalid F231 resolution file: ${path}`);
  }
  return parsed as ResolutionFile;
}

function sameSortedValues(left: string[], right: string[]): boolean {
  return JSON.stringify([...new Set(left)].sort()) === JSON.stringify([...new Set(right)].sort());
}

function groupSourcesByTarget(sources: CandidateWithContent[]): Map<string, CandidateWithContent[]> {
  const byTarget = new Map<string, CandidateWithContent[]>();
  for (const source of sources) {
    const group = byTarget.get(source.targetPath) ?? [];
    group.push(source);
    byTarget.set(source.targetPath, group);
  }
  return byTarget;
}

function addCanonicalCandidates(
  canonicalProfileDir: string,
  byTarget: Map<string, CandidateWithContent[]>,
  priorAppliedHashes: ReadonlyMap<string, string>,
): void {
  for (const [targetPath, candidates] of byTarget) {
    const canonicalPath = resolve(canonicalProfileDir, ...targetPath.split('/'));
    assertWithin(canonicalProfileDir, canonicalPath);
    if (!existsSync(canonicalPath)) continue;
    const canonical = readCandidate('canonical', canonicalPath, targetPath);
    if (priorAppliedHashes.get(targetPath) !== canonical.sha256) candidates.push(canonical);
  }
}

function planTarget(
  targetPath: string,
  candidates: CandidateWithContent[],
  resolutionFile?: ResolutionFile,
): { conflict?: ProfileMigrationConflict; write: TargetWrite } {
  const sourceHashes = [...new Set(candidates.map((candidate) => candidate.sha256))].sort();
  const resolution = resolutionFile?.resolutions[targetPath];
  if (resolution && !sameSortedValues(resolution.expectedSourceHashes, sourceHashes)) {
    throw new Error(
      `Resolution source hashes do not match current sources for ${targetPath}: expected ${resolution.expectedSourceHashes.join(',')}, current ${sourceHashes.join(',')}`,
    );
  }
  const conflict =
    sourceHashes.length > 1
      ? {
          targetPath,
          candidates: candidates.map(({ content: _content, ...candidate }) => candidate),
          resolved: Boolean(resolution),
        }
      : undefined;
  const content = resolution ? readFileSync(resolution.contentFile) : candidates[0].content;
  return { conflict, write: { targetPath, content, sha256: hashContent(content) } };
}

export function buildMigrationPlan(
  options: RunProfileMigrationOptions,
  priorAppliedHashes: ReadonlyMap<string, string> = new Map(),
): MigrationPlan {
  const canonicalProfileDir = resolve(options.dataDir, ...profileUserRelativePath(options.userId).split('/'));
  const legacySources = collectLegacySources(options.legacyRoots, options.relationshipKeys);
  const byTarget = groupSourcesByTarget(legacySources);
  addCanonicalCandidates(canonicalProfileDir, byTarget, priorAppliedHashes);

  const resolutionFile = loadResolutions(options.resolutionFile);
  const conflicts: ProfileMigrationConflict[] = [];
  const targetWrites: TargetWrite[] = [];
  for (const [targetPath, candidates] of [...byTarget.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const planned = planTarget(targetPath, candidates, resolutionFile);
    if (planned.conflict) conflicts.push(planned.conflict);
    targetWrites.push(planned.write);
  }

  const status: MigrationStatus = conflicts.some((conflict) => !conflict.resolved) ? 'blocked' : 'ready';
  const sources = [...byTarget.values()]
    .flat()
    .map(({ content: _content, ...candidate }) => candidate)
    .sort((a, b) => a.targetPath.localeCompare(b.targetPath) || a.sourcePath.localeCompare(b.sourcePath));
  return {
    manifest: {
      version: 1,
      mode: options.apply ? 'apply' : 'dry-run',
      status,
      userId: options.userId,
      canonicalProfileDir,
      sources,
      targets: targetWrites.map(({ targetPath, sha256 }) => ({ targetPath, sha256 })),
      conflicts,
    },
    legacySources,
    targetWrites,
  };
}
