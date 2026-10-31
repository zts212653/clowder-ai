import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { catRegistry } from '@cat-cafe/shared';
import {
  assertProfilePathSegment,
  CURRENT_CORPUS_PROFILE_URI,
  CURRENT_RELATIONSHIP_PROFILE_URI,
  LEGACY_PROFILE_CAPSULE_RELATIVE_PATH,
  PROFILE_CAPSULE_RELATIVE_PATH,
  PROFILE_CORPUS_RELATIVE_PATH,
  PROFILE_MEMORY_TOMBSTONE_PREFIX,
  profileCapsuleReadRelativePath,
  profileUserRelativePath,
  relationshipKeyFromPrimerRelativePath,
  relationshipPrimerRelativePath,
} from '@cat-cafe/shared/profile-contract';
import { profileRevisionOf } from '@cat-cafe/shared/profile-revision';

export interface ProfileScope {
  userId: string;
  catId: string;
  relationshipKey: string;
}

export interface FileProfileRepositoryOptions {
  dataDir?: string;
  homeDir?: string;
  relationshipKeyForCat?: (catId: string) => string | undefined;
}

export interface ProfileFileSnapshot {
  content: string;
  path: string;
  revision: string;
  updatedAt?: number;
}

export interface RelationshipPrimerSnapshot extends ProfileFileSnapshot {
  relationshipKey: string;
  targetPath: string;
}

export function isProfileMemoryTombstoneContent(content: string): boolean {
  return content.startsWith(PROFILE_MEMORY_TOMBSTONE_PREFIX);
}

function defaultRelationshipKeyForCat(catId: string): string | undefined {
  return catRegistry.tryGet(catId)?.config.relationshipKey;
}

/**
 * Canonical F231 user-profile repository.
 *
 * The root is deliberately independent of cwd, install root, and worktree. Legacy
 * private/profile trees are migration inputs only and never participate in runtime reads.
 */
export class FileProfileRepository {
  readonly dataDir: string;
  private readonly relationshipKeyForCat: (catId: string) => string | undefined;

  constructor(options: FileProfileRepositoryOptions = {}) {
    this.dataDir = resolve(
      options.dataDir ?? process.env.CAT_CAFE_DATA_DIR ?? resolve(options.homeDir ?? homedir(), '.cat-cafe'),
    );
    this.relationshipKeyForCat = options.relationshipKeyForCat ?? defaultRelationshipKeyForCat;
  }

  profileDir(userId: string): string {
    return resolve(this.dataDir, ...profileUserRelativePath(userId).split('/'));
  }

  readCapsule(userId: string): ProfileFileSnapshot | null {
    const profileDir = this.profileDir(userId);
    const relativePath = profileCapsuleReadRelativePath((path) => existsSync(resolve(profileDir, path)));
    return readProfileSnapshot(resolve(profileDir, relativePath));
  }

  capsulePath(userId: string): string {
    return resolve(this.profileDir(userId), PROFILE_CAPSULE_RELATIVE_PATH);
  }

  legacyCapsulePath(userId: string): string {
    return resolve(this.profileDir(userId), LEGACY_PROFILE_CAPSULE_RELATIVE_PATH);
  }

  resolveCapsuleTarget(userId: string, targetPath: string): string {
    if (targetPath !== PROFILE_CAPSULE_RELATIVE_PATH) throw new Error('Invalid capsule target');
    return this.capsulePath(userId);
  }

  scope(userId: string, catId: string): ProfileScope {
    profileUserRelativePath(userId);
    assertProfilePathSegment('catId', catId);
    const relationshipKey = this.relationshipKeyForCat(catId);
    if (!relationshipKey) {
      throw new Error(`No relationship key configured for catId "${catId}"; refusing catId fallback`);
    }
    assertProfilePathSegment('relationshipKey', relationshipKey);
    return { userId, catId, relationshipKey };
  }

  /**
   * Resolve a server-pinned proposal target without re-projecting today's catalog.
   * A model/catalog upgrade between propose and approve must not redirect or strand
   * an already-audited proposal.
   */
  scopeForPinnedPrimerTarget(userId: string, catId: string, targetPath: string): ProfileScope {
    profileUserRelativePath(userId);
    assertProfilePathSegment('catId', catId);
    const relationshipKey = relationshipKeyFromPrimerRelativePath(targetPath);
    const currentRelationshipKey = this.relationshipKeyForCat(catId);
    if (!currentRelationshipKey) {
      throw new Error(`No relationship key configured for catId "${catId}"; refusing pinned primer approval`);
    }
    if (relationshipKey === catId && currentRelationshipKey !== relationshipKey) {
      throw new Error(
        `Legacy catId-keyed primer target "${targetPath}" cannot be approved after persona migration; re-propose for relationshipKey "${currentRelationshipKey}"`,
      );
    }
    return { userId, catId, relationshipKey };
  }

  primerPath(scope: ProfileScope): string {
    const relativePath = relationshipPrimerRelativePath(scope.relationshipKey);
    return resolve(this.profileDir(scope.userId), ...relativePath.split('/'));
  }

  resolvePrimerTarget(scope: ProfileScope, targetPath: string): string {
    const expected = relationshipPrimerRelativePath(scope.relationshipKey);
    const normalized = targetPath.replaceAll('\\', '/');
    if (normalized !== expected) {
      throw new Error(`Invalid primer target "${targetPath}"; expected ${expected}`);
    }
    return this.primerPath(scope);
  }

  readPrimer(scope: ProfileScope): ProfileFileSnapshot | null {
    const path = this.primerPath(scope);
    return readProfileSnapshot(path);
  }

  primerPathForRelationship(userId: string, relationshipKey: string): string {
    const relativePath = relationshipPrimerRelativePath(relationshipKey);
    return resolve(this.profileDir(userId), ...relativePath.split('/'));
  }

  listPrimers(userId: string): RelationshipPrimerSnapshot[] {
    const relationshipDir = resolve(this.profileDir(userId), 'relationship');
    if (!existsSync(relationshipDir)) return [];
    const snapshots: RelationshipPrimerSnapshot[] = [];
    for (const entry of readdirSync(relationshipDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('-primer.md')) continue;
      const targetPath = `relationship/${entry.name}`;
      let relationshipKey: string;
      try {
        relationshipKey = relationshipKeyFromPrimerRelativePath(targetPath);
      } catch {
        continue;
      }
      let snapshot: ProfileFileSnapshot | null;
      try {
        snapshot = readProfileSnapshot(join(relationshipDir, entry.name));
      } catch {
        continue;
      }
      if (snapshot) snapshots.push({ ...snapshot, relationshipKey, targetPath });
    }
    return snapshots.sort((left, right) => left.relationshipKey.localeCompare(right.relationshipKey));
  }

  /**
   * Phase E: absolute path for the shared corpus file for a given user.
   */
  corpusPath(userId: string): string {
    return resolve(this.profileDir(userId), ...PROFILE_CORPUS_RELATIVE_PATH.split('/'));
  }

  /**
   * Phase E: read the owner-wide shared corpus. Returns null if not yet written.
   * INV-4: revision uses the canonical profileRevisionOf function.
   */
  readCorpus(userId: string): ProfileFileSnapshot | null {
    const path = this.corpusPath(userId);
    return readProfileSnapshot(path);
  }

  /**
   * Phase E: resolve and validate a corpus targetPath.
   * INV-2: only PROFILE_CORPUS_RELATIVE_PATH is accepted; primer paths and traversals are rejected.
   * A5: path traversal is rejected.
   */
  resolveCorpusTarget(userId: string, targetPath: string): string {
    const normalized = targetPath.replaceAll('\\', '/');
    if (normalized !== PROFILE_CORPUS_RELATIVE_PATH) {
      throw new Error(`Invalid corpus target "${targetPath}"; expected ${PROFILE_CORPUS_RELATIVE_PATH}`);
    }
    return this.corpusPath(userId);
  }

  currentRelationshipUri(): typeof CURRENT_RELATIONSHIP_PROFILE_URI {
    return CURRENT_RELATIONSHIP_PROFILE_URI;
  }

  currentCorpusUri(): typeof CURRENT_CORPUS_PROFILE_URI {
    return CURRENT_CORPUS_PROFILE_URI;
  }
}

function readProfileSnapshot(path: string): ProfileFileSnapshot | null {
  if (!existsSync(path)) return null;
  const content = readFileSync(path, 'utf8');
  if (isProfileMemoryTombstoneContent(content)) return null;
  return { content, path, revision: profileRevisionOf(content), updatedAt: statSync(path).mtimeMs };
}
