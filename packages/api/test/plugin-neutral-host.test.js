import assert from 'node:assert/strict';
import { test } from 'node:test';
import { neutralFixture } from './helpers/neutral-host-fixture.js';

test('production module has no temporary Task artifact publication surface', async (t) => {
  const f = await neutralFixture(t);
  assert.equal(f.host().taskArtifacts, undefined);
  const value = { text: 'not a Task publication', mediaType: 'text/plain' };
  const http = await f.http('taskArtifacts', 'publishText', value);
  assert.equal(http.statusCode, 200);
  assert.deepEqual(http.json(), { available: false, result: null });
  assert.deepEqual(await f.native('taskArtifacts', 'publishText', value), { available: false, result: null });
});
