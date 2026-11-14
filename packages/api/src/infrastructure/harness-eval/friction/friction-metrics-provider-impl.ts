import type { FrictionRollupSourceSelector } from '@cat-cafe/shared';
import type { IEmbeddingService } from '../../../domains/memory/interfaces.js';
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
export type FrictionMetricsProviderDeps = FrictionMeasurementPilotDeps & {
  getLegacyEmbeddingService?: () => IEmbeddingService | undefined;
};

export class FrictionMetricsProviderImpl implements FrictionMetricsProvider {
  constructor(private readonly deps: FrictionMetricsProviderDeps) {}

  async resolve(selector: FrictionRollupSourceSelector) {
    // Resolve once before capture begins: late service readiness is visible, but
    // asynchronous source reads cannot change this measurement's geometry.
    const resolved = this.deps.getLegacyEmbeddingService
      ? this.deps.getLegacyEmbeddingService()
      : this.deps.embeddingService;
    const embeddingService =
      this.deps.getLegacyEmbeddingService && resolved && (resolved.getModelInfo().generationId ?? 'g0') !== 'g0'
        ? undefined
        : resolved;
    return captureFrictionMeasurementPilot({ ...this.deps, embeddingService }, selector);
  }
}
