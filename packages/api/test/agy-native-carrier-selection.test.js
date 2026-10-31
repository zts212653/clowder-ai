import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createGoogleAgentService } from '../dist/domains/cats/services/agents/providers/agy-native/agy-native-carrier-selection.js';

test('one profile selects one AGY carrier without a fallback', () => {
  for (const profile of [undefined, { enabled: true, carrier: 'legacy', profileId: 'gemini38' }]) {
    assert.throws(
      () => createGoogleAgentService('gemini38', profile),
      (error) => error.reason?.code === 'AGY_NATIVE_SETUP_REQUIRED',
    );
  }
  const native = createGoogleAgentService('gemini38', {
    enabled: true,
    carrier: 'native',
    profileId: 'gemini38',
    homeRoot: '/tmp/f325-isolated-profile',
    model: 'gemini-3.8-flash-high',
  });
  assert.equal(native.constructor.name, 'AgyNativeAgentService');
  assert.equal(native.supportsToolExecutionPolicy({ mode: 'callback_allowlist', allowedCallbackRoutes: [] }), false);
  assert.equal(native.supportsToolExecutionPolicy({ mode: 'collective_participation' }), false);
  assert.equal(native.supportsToolExecutionPolicy({ mode: 'read_only' }), true);
});
