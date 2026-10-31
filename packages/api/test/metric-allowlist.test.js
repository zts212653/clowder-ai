/**
 * F152 Metric Allowlist — regression for the C2 build verdict labels.
 *
 * The OTel SDK silently drops any attribute not in `ALLOWED_METRIC_ATTRIBUTES`.
 * That means a counter site can add as many label keys as it likes; if the keys
 * are not in the allowlist they never reach Prometheus, attribution, or the eval
 * snapshot. That exact failure mode almost shipped in PR #2058 R1 (砚砚 caught it
 * before merge): the C2 counters carried label keys that were not allowlisted,
 * so the build verdict's observability goal would have failed silently. The fix
 * landed `thread.system_kind` (THREAD_SYSTEM_KIND) and reused `trigger` (TRIGGER)
 * for the matched keyword. This test locks in the current contract — both keys
 * stay allowlisted, and the string literals match what a Prometheus query would
 * reference.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  PROFILE_LAYER,
  TARGET_LAYER,
  THREAD_SYSTEM_KIND,
  TRIGGER,
} from '../dist/infrastructure/telemetry/genai-semconv.js';
import { ALLOWED_METRIC_ATTRIBUTES } from '../dist/infrastructure/telemetry/metric-allowlist.js';
import {
  TURN_CUSTODY_METRIC_CLASSIFICATION_ATTR,
  TURN_CUSTODY_METRIC_COMPARISON_ATTR,
  TURN_CUSTODY_METRIC_STATE_ATTR,
  TURN_CUSTODY_PROMETHEUS_CLASSIFICATION_LABEL,
  TURN_CUSTODY_PROMETHEUS_COMPARISON_LABEL,
  TURN_CUSTODY_PROMETHEUS_STATE_LABEL,
} from '../dist/infrastructure/telemetry/turn-custody-shadow-telemetry.js';

describe('F152 metric-allowlist — C2 observability labels (PR #2058 R1 regression)', () => {
  test('THREAD_SYSTEM_KIND is allowlisted (otherwise C2 thread-kind breakdown is silently dropped)', () => {
    assert.ok(
      ALLOWED_METRIC_ATTRIBUTES.has(THREAD_SYSTEM_KIND),
      `metric-allowlist must include ${THREAD_SYSTEM_KIND} so C2 counters can attribute by thread kind`,
    );
  });

  test('TRIGGER is allowlisted (reused by C2 verdict-fire counters for the matched keyword)', () => {
    // TRIGGER predates this PR (invoke-single-cat uses it for triggerType), but the
    // assertion guards against a future refactor removing it from the allowlist.
    assert.ok(
      ALLOWED_METRIC_ATTRIBUTES.has(TRIGGER),
      `metric-allowlist must include ${TRIGGER} — used by both catInvocationCount (triggerType) and the C2 verdict-fire counters (matched keyword)`,
    );
  });

  test('label keys are the expected string literals (lock in cross-package contract)', () => {
    // If someone refactors genai-semconv to rename the constant *value*, Prometheus
    // queries written against the old name would silently break. Pin the values.
    assert.equal(THREAD_SYSTEM_KIND, 'thread.system_kind');
    assert.equal(TRIGGER, 'trigger');
  });
});

describe('F167 Phase T metric-allowlist — bounded stop-gate labels', () => {
  test('preserves namespaced projection and comparison dimensions', () => {
    assert.ok(ALLOWED_METRIC_ATTRIBUTES.has(TURN_CUSTODY_METRIC_STATE_ATTR));
    assert.ok(ALLOWED_METRIC_ATTRIBUTES.has(TURN_CUSTODY_METRIC_COMPARISON_ATTR));
    assert.ok(ALLOWED_METRIC_ATTRIBUTES.has(TURN_CUSTODY_METRIC_CLASSIFICATION_ATTR));
  });

  describe('F231 Phase E metric-allowlist — per-layer profile telemetry', () => {
    test('P1: PROFILE_LAYER is allowlisted (otherwise pointer_emitted per-layer breakdown is silently dropped)', () => {
      assert.ok(
        ALLOWED_METRIC_ATTRIBUTES.has(PROFILE_LAYER),
        `metric-allowlist must include ${PROFILE_LAYER} so profile pointer telemetry can attribute by layer (primer/corpus)`,
      );
    });

    test('P1: TARGET_LAYER is allowlisted (otherwise propose/approve/reject per-layer breakdown is silently dropped)', () => {
      assert.ok(
        ALLOWED_METRIC_ATTRIBUTES.has(TARGET_LAYER),
        `metric-allowlist must include ${TARGET_LAYER} so profile update telemetry can attribute by target layer`,
      );
    });

    test('pins string literal values for Prometheus query stability', () => {
      assert.equal(PROFILE_LAYER, 'profile.layer');
      assert.equal(TARGET_LAYER, 'target.layer');
    });
  });

  test('does not widen the global allowlist to generic state/comparison keys', () => {
    assert.equal(ALLOWED_METRIC_ATTRIBUTES.has('state'), false);
    assert.equal(ALLOWED_METRIC_ATTRIBUTES.has('comparison'), false);
    assert.equal(ALLOWED_METRIC_ATTRIBUTES.has('classification'), false);
  });

  test('pins OTel attribute and Prometheus label names across the exporter boundary', () => {
    assert.equal(TURN_CUSTODY_METRIC_STATE_ATTR, 'turn_custody.state');
    assert.equal(TURN_CUSTODY_METRIC_COMPARISON_ATTR, 'turn_custody.comparison');
    assert.equal(TURN_CUSTODY_METRIC_CLASSIFICATION_ATTR, 'turn_custody.classification');
    assert.equal(TURN_CUSTODY_PROMETHEUS_STATE_LABEL, 'turn_custody_state');
    assert.equal(TURN_CUSTODY_PROMETHEUS_COMPARISON_LABEL, 'turn_custody_comparison');
    assert.equal(TURN_CUSTODY_PROMETHEUS_CLASSIFICATION_LABEL, 'turn_custody_classification');
  });
});
