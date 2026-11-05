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

test('real module captures canonical owner Chat only in the current native action lifetime', async (t) => {
  const f = await neutralFixture(t);
  const message = await f.messages.append({
    threadId: f.thread.id,
    userId: f.owner,
    content: 'Please use my selected plugin.',
    timestamp: 1,
    from: { kind: 'user', userId: f.owner },
  });
  assert.equal(typeof f.host().ownerChat.capture, 'function');
  await assert.rejects(f.host().ownerChat.capture(), /owner_chat/);
  await assert.rejects(f.native('ownerChat', 'capture'), /owner_chat/);
  const result = await f.native('ownerChat', 'capture', undefined, {
    ownerAuthProvenance: 'strict',
    originTriggerMessageId: message.id,
    assertWriteCurrent: () => {},
  });
  assert.equal(result.available, true);
  assert.deepEqual(result.result.origin, { messageId: message.id, threadId: f.thread.id, helperCatId: 'cat' });
  // The module checked the synchronous fence while current; this API-side proxy crosses RPC again.
  await assert.rejects(result.result.assertWriteCurrent(), /no longer current/);
});
