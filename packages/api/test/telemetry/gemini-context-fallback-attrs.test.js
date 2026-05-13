/**
 * Invariant test: attributes used by `geminiContextFallback` counter
 * (in invoke-single-cat.ts) must be in ALLOWED_METRIC_ATTRIBUTES, otherwise
 * the OTel SDK's allowlist View will silently drop them and we lose the
 * `trigger` dimension we need for diagnosing fallback patterns.
 *
 * If you change the attribute keys passed to `geminiContextFallback.add(...)`,
 * either update this test to match OR add the new attribute to the allowlist
 * via `genai-semconv.ts` + `metric-allowlist.ts`.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const { ALLOWED_METRIC_ATTRIBUTES } = await import('../../dist/infrastructure/telemetry/metric-allowlist.js');
const { AGENT_ID, TRIGGER } = await import('../../dist/infrastructure/telemetry/genai-semconv.js');

describe('geminiContextFallback metric attributes', () => {
  test('AGENT_ID is in the metric allowlist', () => {
    assert.ok(
      ALLOWED_METRIC_ATTRIBUTES.has(AGENT_ID),
      `AGENT_ID (${AGENT_ID}) must be in ALLOWED_METRIC_ATTRIBUTES so it survives the SDK allowlist View`,
    );
  });

  test('TRIGGER is in the metric allowlist', () => {
    assert.ok(
      ALLOWED_METRIC_ATTRIBUTES.has(TRIGGER),
      `TRIGGER (${TRIGGER}) must be in ALLOWED_METRIC_ATTRIBUTES so it survives the SDK allowlist View`,
    );
  });

  test('"reason" (the previous attr name) is NOT in the allowlist — guards against regression', () => {
    // Previous version of this counter used { reason: 'no_per_turn_signal' }
    // which the SDK silently dropped. If this test starts failing, it means
    // someone added 'reason' to the allowlist — which is fine, but please also
    // confirm the geminiContextFallback.add(...) call site is updated.
    assert.equal(
      ALLOWED_METRIC_ATTRIBUTES.has('reason'),
      false,
      '"reason" should NOT be a generic metric attribute — use TRIGGER for categorical labels',
    );
  });
});
