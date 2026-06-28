import { type AnchorTelemetryRollup, getAnchorTelemetryRollup } from '../../../routes/anchor-event-log.js';
import type { AnchorTelemetryMetricsProvider } from '../publish-verdict/anchor-telemetry-generator-adapter.js';
import type { AnchorTelemetrySourceSelector } from '../publish-verdict/types.js';

/**
 * F236 Track-2 — production AnchorTelemetryMetricsProvider.
 *
 * Trivial: wraps getAnchorTelemetryRollup(window) from the in-memory event log.
 * No store deps, no complex composition — pure ctor, unconditionally wireable.
 */
export class AnchorTelemetryProviderImpl implements AnchorTelemetryMetricsProvider {
  async resolve(selector: AnchorTelemetrySourceSelector): Promise<AnchorTelemetryRollup> {
    return getAnchorTelemetryRollup({
      windowStartMs: selector.windowStartMs,
      windowEndMs: selector.windowEndMs,
    });
  }
}
