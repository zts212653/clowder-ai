import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const { ALLOWED_METRIC_ATTRIBUTES } = await import('../../dist/infrastructure/telemetry/metric-allowlist.js');
const { AGENT_ID, TRIGGER } = await import('../../dist/infrastructure/telemetry/genai-semconv.js');

describe('geminiContextFallback metric attributes', () => {
  test('keeps exported metric attributes allowlisted', () => {
    assert.ok(ALLOWED_METRIC_ATTRIBUTES.has(AGENT_ID));
    assert.ok(ALLOWED_METRIC_ATTRIBUTES.has(TRIGGER));
  });

  test('does not depend on non-allowlisted reason attribute', () => {
    assert.equal(ALLOWED_METRIC_ATTRIBUTES.has('reason'), false);
  });
});
