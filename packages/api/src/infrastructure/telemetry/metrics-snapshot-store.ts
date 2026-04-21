/**
 * F153 Phase E L1.5: In-memory ring buffer for metrics time-series snapshots.
 *
 * Sampled periodically from PrometheusExporter.collect(), stores projected
 * gauge/counter values for Hub trend charts. Dual-threshold eviction:
 * maxSnapshots cap + maxAgeMs TTL.
 */

export interface MetricsSnapshot {
  timestamp: number;
  metrics: Record<string, number>;
}

export interface MetricsSnapshotStoreConfig {
  /** Max snapshots in buffer (default 720 = 6h at 30s interval). */
  maxSnapshots?: number;
  /** Max age in ms before eviction (default 21600000 = 6h). */
  maxAgeMs?: number;
}

export interface MetricsSnapshotStoreStats {
  snapshotCount: number;
  maxSnapshots: number;
  maxAgeMs: number;
  oldestTimestamp: number | null;
  newestTimestamp: number | null;
}

const DEFAULT_MAX_SNAPSHOTS = 720;
const DEFAULT_MAX_AGE_MS = 6 * 60 * 60 * 1000; // 6 hours

export class MetricsSnapshotStore {
  private readonly buffer: MetricsSnapshot[] = [];
  private readonly maxSnapshots: number;
  private readonly maxAgeMs: number;

  constructor(config?: MetricsSnapshotStoreConfig) {
    this.maxSnapshots = config?.maxSnapshots ?? DEFAULT_MAX_SNAPSHOTS;
    this.maxAgeMs = config?.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
  }

  add(snapshot: MetricsSnapshot): void {
    this.evictExpired();
    while (this.buffer.length >= this.maxSnapshots) {
      this.buffer.shift();
    }
    this.buffer.push(snapshot);
  }

  query(since?: number, limit?: number): MetricsSnapshot[] {
    this.evictExpired();
    const maxResults = limit ?? this.maxSnapshots;
    if (!since) {
      return this.buffer.slice(-maxResults);
    }
    const results: MetricsSnapshot[] = [];
    for (const snap of this.buffer) {
      if (results.length >= maxResults) break;
      if (snap.timestamp >= since) {
        results.push(snap);
      }
    }
    return results;
  }

  stats(): MetricsSnapshotStoreStats {
    this.evictExpired();
    return {
      snapshotCount: this.buffer.length,
      maxSnapshots: this.maxSnapshots,
      maxAgeMs: this.maxAgeMs,
      oldestTimestamp: this.buffer.length > 0 ? this.buffer[0].timestamp : null,
      newestTimestamp: this.buffer.length > 0 ? this.buffer[this.buffer.length - 1].timestamp : null,
    };
  }

  clear(): void {
    this.buffer.length = 0;
  }

  private evictExpired(): void {
    const cutoff = Date.now() - this.maxAgeMs;
    while (this.buffer.length > 0 && this.buffer[0].timestamp < cutoff) {
      this.buffer.shift();
    }
  }
}

/**
 * Parse Prometheus text format into a flat metric name → value map.
 * Extracts only gauge and counter values (skips histograms/summaries _bucket/_sum/_count).
 */
export function parsePrometheusText(text: string): Record<string, number> {
  const metrics: Record<string, number> = {};
  for (const line of text.split('\n')) {
    if (!line || line.startsWith('#')) continue;
    // Skip histogram/summary sub-metrics — they're not useful for trend cards
    if (/_bucket\{/.test(line) || /_count\{/.test(line) || /_sum\{/.test(line)) continue;
    const match = line.match(/^([^\s{]+)(?:\{([^}]*)\})?\s+([\d.eE+-]+)(?:\s+\d+)?$/);
    if (!match) continue;
    const [, name, labels, valueStr] = match;
    const value = Number.parseFloat(valueStr);
    if (Number.isNaN(value)) continue;
    const key = labels ? `${name}{${labels}}` : name;
    metrics[key] = value;
  }
  return metrics;
}
