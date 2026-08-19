export interface CodexAppServerHostPoolMetrics {
  liveHostCount: number;
  activeLeaseCount: number;
  warmHostCount: number;
  coldStartCount: number;
  warmHitCount: number;
  evictionCount: number;
}

export function emptyCodexAppServerHostPoolMetrics(): CodexAppServerHostPoolMetrics {
  return {
    liveHostCount: 0,
    activeLeaseCount: 0,
    warmHostCount: 0,
    coldStartCount: 0,
    warmHitCount: 0,
    evictionCount: 0,
  };
}
