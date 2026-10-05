import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createGoogleAgentService } from '../dist/domains/cats/services/agents/providers/agy-native/agy-native-carrier-selection.js';

test('one profile selects one AGY carrier without a fallback', () => {
  const previousModel = process.env.CAT_GEMINI38_MODEL;
  process.env.CAT_GEMINI38_MODEL = 'gemini-3.8-flash-high';
  try {
    const legacy = createGoogleAgentService('gemini38');
    assert.equal(legacy.constructor.name, 'GeminiAgentService');
  } finally {
    if (previousModel === undefined) delete process.env.CAT_GEMINI38_MODEL;
    else process.env.CAT_GEMINI38_MODEL = previousModel;
  }
  const native = createGoogleAgentService('gemini38', {
    enabled: true,
    carrier: 'native',
    profileId: 'gemini38',
    homeRoot: '/tmp/f325-isolated-profile',
    model: 'gemini-3.8-flash-high',
  });
  assert.equal(native.constructor.name, 'AgyNativeAgentService');
  assert.equal(native.supportsToolExecutionPolicy({ mode: 'callback_allowlist', allowedCallbackRoutes: [] }), true);
  assert.equal(native.supportsToolExecutionPolicy({ mode: 'collective_participation' }), false);
});
