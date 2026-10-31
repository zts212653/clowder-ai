import { saveSpan } from '../../../../../../utils/member-save-diagnostics.js';
import { trackAcpPoolRetirement } from './pool/acp-pool-retirement-registry.js';
import { retireAcpServicePool } from './pool/acp-service-pool-lease.js';

export interface ClosableAcpPool {
  closeAll(): Promise<void>;
}

export interface CloseStaleAcpPoolsOptions {
  reason?: string;
  onCloseError?: (err: unknown, profileId: string, reason: string) => void;
}

export async function closeStaleAcpPools<TPool extends ClosableAcpPool>(
  registry: Map<string, TPool>,
  activeProfileIds: ReadonlySet<string>,
  options: CloseStaleAcpPoolsOptions = {},
): Promise<string[]> {
  const reason = options.reason ?? 'stale-acp-pool';
  const closedProfileIds: string[] = [];

  for (const [profileId, pool] of [...registry.entries()]) {
    if (activeProfileIds.has(profileId)) continue;

    try {
      const retirement = retireAcpServicePool(pool);
      trackAcpPoolRetirement(registry, profileId, retirement.completion);
      // Admission now reads the exit fence separately; never lend a closing registry entry.
      if (registry.get(profileId) === pool) registry.delete(profileId);
      if (!retirement.deferredForActiveWork)
        await saveSpan('pool.acp.close', () => retirement.completion, { catId: profileId });
    } catch (err) {
      options.onCloseError?.(err, profileId, reason);
    } finally {
      if (registry.get(profileId) === pool) registry.delete(profileId);
      closedProfileIds.push(profileId);
    }
  }

  return closedProfileIds;
}
