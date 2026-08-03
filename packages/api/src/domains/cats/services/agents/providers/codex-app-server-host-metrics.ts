export interface CodexAppServerHostPoolMetrics {
  liveHostCount: number;
  activeLeaseCount: number;
  warmHostCount: number;
  coldStartCount: number;
  warmHitCount: number;
  evictionCount: number;
}
