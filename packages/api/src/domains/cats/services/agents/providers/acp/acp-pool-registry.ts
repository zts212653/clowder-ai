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
      await pool.closeAll();
    } catch (err) {
      options.onCloseError?.(err, profileId, reason);
    } finally {
      registry.delete(profileId);
      closedProfileIds.push(profileId);
    }
  }

  return closedProfileIds;
}
