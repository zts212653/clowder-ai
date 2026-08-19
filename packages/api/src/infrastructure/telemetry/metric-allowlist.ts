/**
 * F152: Metric Attribute Allowlist — D2 code-level enforcement.
 *
 * Every OTel instrument is registered with a View that restricts
 * its attributes to the allowlist. Non-allowed attributes are
 * silently dropped by the SDK (not aggregated, not exported).
 *
 * This prevents anyone from accidentally adding high-cardinality
 * attributes (threadId, invocationId, etc.) to metrics.
 */

import { createAllowListAttributesProcessor, type ViewOptions } from '@opentelemetry/sdk-metrics';
import {
  ACTION_SUCCESSOR_MODE,
  AGENT_ID,
  ANCHOR_TOOL,
  CALLBACK_REASON,
  CALLBACK_TOOL,
  FRESHNESS_RELEVANCE_REASON,
  GENAI_MODEL,
  GENAI_SYSTEM,
  GROUNDING_ACTION_FAMILY,
  GROUNDING_CLAIM_TYPE,
  GROUNDING_SOURCE_TIER,
  GROUNDING_VERDICT,
  OPERATION_NAME,
  ROUTING_EVENT_WAIT_REASON,
  SEAL_REASON,
  SIGNAL_KIND,
  STATUS,
  STREAM_ERROR_PATH,
  THREAD_SYSTEM_KIND,
  TRIGGER,
} from './genai-semconv.js';
import {
  TURN_CUSTODY_METRIC_CLASSIFICATION_ATTR,
  TURN_CUSTODY_METRIC_COMPARISON_ATTR,
  TURN_CUSTODY_METRIC_STATE_ATTR,
} from './turn-custody-shadow-telemetry.js';

/** The ONLY attributes allowed on metric instruments. */
export const ALLOWED_METRIC_ATTRIBUTES: ReadonlySet<string> = new Set([
  AGENT_ID,
  GENAI_SYSTEM,
  GENAI_MODEL,
  OPERATION_NAME,
  ACTION_SUCCESSOR_MODE,
  ROUTING_EVENT_WAIT_REASON,
  STATUS,
  STREAM_ERROR_PATH,
  TRIGGER,
  THREAD_SYSTEM_KIND,
  CALLBACK_TOOL,
  CALLBACK_REASON,
  FRESHNESS_RELEVANCE_REASON,
  SIGNAL_KIND,
  SEAL_REASON,
  // F236 Track-1: anchor-first telemetry per-tool breakdown.
  ANCHOR_TOOL,
  // F167 Phase O PR-O2: claim grounding shadow telemetry.
  // Bounded cardinality: claim_type(7), verdict(3), action_family(9), source_tier(3).
  GROUNDING_CLAIM_TYPE,
  GROUNDING_VERDICT,
  GROUNDING_ACTION_FAMILY,
  GROUNDING_SOURCE_TIER,
  // F167 Phase T: bounded projection(3) and comparison(4) dimensions.
  TURN_CUSTODY_METRIC_STATE_ATTR,
  TURN_CUSTODY_METRIC_COMPARISON_ATTR,
  TURN_CUSTODY_METRIC_CLASSIFICATION_ATTR,
]);

const allowedKeys = [...ALLOWED_METRIC_ATTRIBUTES];

/**
 * Create OTel Views that enforce the attribute allowlist for our instruments.
 * Pass these to the MeterProvider configuration.
 */
export function createMetricAllowlistViews(): ViewOptions[] {
  return [
    {
      instrumentName: 'cat_cafe.*',
      attributesProcessors: [createAllowListAttributesProcessor(allowedKeys)],
    },
  ];
}

/**
 * Create a ViewOptions for a specific instrument name.
 * Use this when you need fine-grained per-instrument control.
 */
export function createInstrumentView(instrumentName: string): ViewOptions {
  return {
    instrumentName,
    attributesProcessors: [createAllowListAttributesProcessor(allowedKeys)],
  };
}
