import { FRESHNESS_RELEVANCE_REASON } from '../../../../infrastructure/telemetry/genai-semconv.js';
import { freshnessRelevanceSuppressed } from '../../../../infrastructure/telemetry/instruments.js';
import type { FreshnessRelevanceReason } from './FreshnessRelevancePolicy.js';

export function recordFreshnessRelevanceSuppression(reason: FreshnessRelevanceReason, count = 1): void {
  if (reason === 'relevant' || !Number.isInteger(count) || count <= 0) return;
  freshnessRelevanceSuppressed.add(count, { [FRESHNESS_RELEVANCE_REASON]: reason });
}
