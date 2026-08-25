import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { catRegistry } from '@cat-cafe/shared';
import {
  assertProfilePathSegment,
  CURRENT_RELATIONSHIP_PROFILE_URI,
  profileUserRelativePath,
  relationshipKeyFromPrimerRelativePath,
  relationshipPrimerRelativePath,
} from '@cat-cafe/shared/profile-contract';

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

  readCapsule(userId: string): { content: string; path: string } | null {
    const path = resolve(this.profileDir(userId), 'landy-capsule.md');
    if (!existsSync(path)) return null;
    return { content: readFileSync(path, 'utf8'), path };
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

  readPrimer(scope: ProfileScope): { content: string; path: string } | null {
    const path = this.primerPath(scope);
    if (!existsSync(path)) return null;
    return { content: readFileSync(path, 'utf8'), path };
  }

  currentRelationshipUri(): typeof CURRENT_RELATIONSHIP_PROFILE_URI {
    return CURRENT_RELATIONSHIP_PROFILE_URI;
  }
}
