import assert from 'node:assert/strict';
import { test } from 'node:test';
import { realtimeStartParams } from './realtime-start.mjs';

test('cat context augments native realtime protocol without replacing it or scanning other workspace history', () => {
  const params = realtimeStartParams('native-1', 'offer', 'Astra; bounded document permission');
  assert.equal(Object.hasOwn(params, 'prompt'), false);
  assert.equal(params.includeStartupContext, false);
  assert.equal(params.clientManagedHandoffs, false);
  assert.deepEqual(params.initialItems, [{ role: 'developer', text: 'Astra; bounded document permission' }]);
});
