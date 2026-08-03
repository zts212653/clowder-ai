import type { FrictionRollupSourceSelector } from '@cat-cafe/shared';
import type { FrictionMetricsProvider } from '../publish-verdict/friction-generator-adapter.js';
import { captureFrictionMeasurementPilot, type FrictionMeasurementPilotDeps } from './friction-measurement-pilot.js';

/**
 * F245 Phase C PR1b — production FrictionMetricsProvider.
 *
 * F267 Phase A wraps the 4 Phase A/B channel adapters in one frozen measurement
 * capture: canonical cancel rows are read once, adapter emissions are captured
 * once, then aggregate → cluster replays those values. All stores remain READ-ONLY
 * (KD-4): no writeback anywhere in this path.
 *
 * deps use `Pick<>` so tests can inject narrow stubs. embeddingService is optional
 * — when absent (or not ready) the clusterer fails open to rule-only clustering
 * and marks the downstream measurement degraded rather than hiding uncertainty.
 */
export type FrictionMetricsProviderDeps = FrictionMeasurementPilotDeps;

export class FrictionMetricsProviderImpl implements FrictionMetricsProvider {
  constructor(private readonly deps: FrictionMetricsProviderDeps) {}

  async resolve(selector: FrictionRollupSourceSelector) {
    return captureFrictionMeasurementPilot(this.deps, selector);
  }
}
