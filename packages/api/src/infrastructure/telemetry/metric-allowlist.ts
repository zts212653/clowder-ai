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
import { AGENT_ID, GENAI_MODEL, GENAI_SYSTEM, OPERATION_NAME, STATUS, STREAM_ERROR_PATH } from './genai-semconv.js';

/** The ONLY attributes allowed on metric instruments. */
export const ALLOWED_METRIC_ATTRIBUTES: ReadonlySet<string> = new Set([
  AGENT_ID,
  GENAI_SYSTEM,
  GENAI_MODEL,
  OPERATION_NAME,
  STATUS,
  STREAM_ERROR_PATH,
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
