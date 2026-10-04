/**
 * Resolve the current Repo Inbox owner from the canonical per-repo community
 * routing config. The environment value is compatibility fallback only for
 * allowlisted repos that have not been registered yet.
 *
 * The store is read on every delivery so changing `guardCatId` takes effect
 * without rebuilding scheduler specs or restarting the connector gateway.
 */
import type { ICommunityRepoConfigStore } from '../../../domains/community/CommunityRepoConfigStore.js';

export type RepoInboxOwnerConfigStore = Pick<ICommunityRepoConfigStore, 'getByRepo'>;
export type ResolveRepoInboxCatId = (repoFullName: string) => Promise<string>;

export interface RepoInboxOwnerLogger {
  warn(context: { repoFullName: string; fallbackCatId: string }, message: string): void;
}

export function createRepoInboxOwnerResolver(
  repoConfigStore: RepoInboxOwnerConfigStore,
  fallbackCatId: string,
  log?: RepoInboxOwnerLogger,
): ResolveRepoInboxCatId {
  const normalizedFallback = fallbackCatId.trim();

  return async (repoFullName) => {
    const config = await repoConfigStore.getByRepo(repoFullName);
    const configuredOwner = config?.guardCatId.trim();
    if (configuredOwner) return configuredOwner;
    if (normalizedFallback) {
      log?.warn(
        { repoFullName, fallbackCatId: normalizedFallback },
        '[repo-inbox] Canonical repo owner missing; using GITHUB_REPO_INBOX_CAT_ID fallback',
      );
      return normalizedFallback;
    }
    throw new Error(`[repo-inbox] No owner configured for ${repoFullName}`);
  };
}
