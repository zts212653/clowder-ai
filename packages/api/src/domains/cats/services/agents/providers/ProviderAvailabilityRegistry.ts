/**
 * In-process holder for the latest provider-availability report.
 *
 * Two properties matter to callers:
 *
 *  - **Copy-on-write publish.** A round stores a whole new report rather than mutating the
 *    previous one, so a reader never observes a half-updated provider set and never blocks on
 *    a round in flight.
 *  - **Detection is advisory, never a gate on its own.** A report can be stale (the machine can
 *    change between rounds), so consumers that want to refuse work must check freshness via
 *    {@link ProviderAvailabilityRegistry.getFreshReport} instead of reading a snapshot forever.
 *    This is why `seed()` exists separately from `refresh()`: hydrating the persisted snapshot
 *    gives the first paint something to show without pretending it is current.
 */

import { createModuleLogger } from '../../../../../infrastructure/logger.js';
import {
  detectProviderAvailability,
  type ProviderAvailability,
  type ProviderAvailabilityReport,
  type ProviderDetectionDeps,
} from './provider-detection.js';

const log = createModuleLogger('provider-availability');

/** Env knob for the periodic re-check. Registered in config/env-registry.ts. */
export const PROVIDER_DISCOVERY_INTERVAL_ENV = 'CAT_PROVIDER_DISCOVERY_INTERVAL_MS';
const DEFAULT_DISCOVERY_INTERVAL_MS = 300_000;

/** Read the configured interval; 0 disables the periodic loop. */
export function resolveDiscoveryIntervalMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[PROVIDER_DISCOVERY_INTERVAL_ENV]?.trim();
  if (raw === undefined || raw === '') return DEFAULT_DISCOVERY_INTERVAL_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    log.warn({ raw, fallbackMs: DEFAULT_DISCOVERY_INTERVAL_MS }, 'ignoring invalid discovery interval');
    return DEFAULT_DISCOVERY_INTERVAL_MS;
  }
  return Math.floor(parsed);
}

export interface ProviderAvailabilityRegistryDeps extends ProviderDetectionDeps {
  /** Called after every successful publish (persistence, metrics). Must not throw. */
  onReport?: (report: ProviderAvailabilityReport) => void;
  /** Injected for tests so no real timer is created. */
  now?: () => number;
}

export class ProviderAvailabilityRegistry {
  private report: ProviderAvailabilityReport | null = null;
  private publishedAtMs: number | null = null;
  private inflight: Promise<ProviderAvailabilityReport> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly deps: ProviderAvailabilityRegistryDeps = {}) {}

  /** Publish a report without running detection (startup hydration from the snapshot). */
  seed(report: ProviderAvailabilityReport): void {
    this.publish(report, false);
  }

  /** Latest known report, or null before the first publish. */
  getReport(): ProviderAvailabilityReport | null {
    return this.report;
  }

  /** Latest known availability for one client, or undefined. */
  getProvider(clientId: string): ProviderAvailability | undefined {
    return this.report?.providers.find((provider) => provider.clientId === clientId);
  }

  /** Age of the latest report in ms, or null when nothing has been published. */
  getAgeMs(): number | null {
    if (this.publishedAtMs === null) return null;
    return (this.deps.now ?? Date.now)() - this.publishedAtMs;
  }

  /**
   * Latest report only if it is younger than `maxAgeMs`. Returns null otherwise, which callers
   * must treat as "unknown" — never as "missing".
   */
  getFreshReport(maxAgeMs: number): ProviderAvailabilityReport | null {
    const age = this.getAgeMs();
    if (this.report === null || age === null || age > maxAgeMs) return null;
    return this.report;
  }

  /**
   * Run a detection round and publish it. Concurrent callers share one round rather than
   * spawning a second sweep of CLI lookups.
   *
   * Deliberately not `async`: an async wrapper would re-wrap the return value and destroy the
   * promise identity this sharing relies on.
   */
  refresh(): Promise<ProviderAvailabilityReport> {
    if (this.inflight) return this.inflight;
    this.inflight = detectProviderAvailability(this.deps)
      .then((report) => {
        this.publish(report, true);
        return report;
      })
      .finally(() => {
        this.inflight = null;
      });
    return this.inflight;
  }

  /**
   * Refresh immediately, then re-check on the configured interval. Idempotent.
   *
   * The first refresh is not awaited: detection resolves PATH lookups and must never delay the
   * HTTP listener. A failure is logged and left for the next tick.
   */
  start(options: { intervalMs?: number } = {}): void {
    if (this.timer) return;
    void this.refresh().catch((error) => {
      log.warn({ error: String(error) }, 'initial provider detection failed');
    });

    const intervalMs = options.intervalMs ?? resolveDiscoveryIntervalMs();
    if (intervalMs <= 0) {
      log.info({ env: PROVIDER_DISCOVERY_INTERVAL_ENV }, 'periodic provider detection disabled');
      return;
    }
    const timer = setInterval(() => {
      void this.refresh().catch((error) => {
        log.warn({ error: String(error) }, 'periodic provider detection failed');
      });
    }, intervalMs);
    // Never hold the process open just to re-check CLIs.
    timer.unref?.();
    this.timer = timer;
    log.info({ intervalMs }, 'periodic provider detection started');
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  isRunning(): boolean {
    return this.timer !== null;
  }

  private publish(report: ProviderAvailabilityReport, notify: boolean): void {
    this.report = report;
    this.publishedAtMs = (this.deps.now ?? Date.now)();
    if (!notify) return;
    const installed = report.providers.filter((provider) => provider.installed).map((p) => p.clientId);
    log.info({ installed, versionProbeEnabled: report.versionProbeEnabled }, 'provider availability detected');
    try {
      this.deps.onReport?.(report);
    } catch (error) {
      // Persistence is a convenience; it must never fail a detection round.
      log.warn({ error: String(error) }, 'provider availability onReport hook failed');
    }
  }
}
