import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
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

test('conversation inventory requires the storage plugin and a current owner scan request', async (t) => {
  const empty = { threads: [], files: [], roots: [], nativeSessions: [], omissions: [] };
  const other = await neutralFixture(t, { conversationStorage: async () => empty });
  assert.equal(other.host().conversationStorage, undefined);

  let reads = 0;
  const fixture = await neutralFixture(t, {
    pluginId: 'official.storage-governance',
    webhookPath: 'scan',
    async conversationStorage(signal) {
      signal.throwIfAborted();
      reads += 1;
      return empty;
    },
  });
  await assert.rejects(fixture.host().conversationStorage.startRead(), /authenticated owner scan/);
  assert.notEqual((await fixture.httpGet('conversationStorage', 'startRead')).statusCode, 200);
  assert.equal(reads, 0);
  const response = await fixture.http('conversationStorage', 'startRead');
  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(response.json(), { available: true, result: empty });
  assert.equal(reads, 1);
});

test('an admitted inventory keeps reading after the owner scan HTTP response ends', async (t) => {
  const pending = Promise.withResolvers();
  const empty = { threads: [], files: [], roots: [], nativeSessions: [], omissions: [] };
  const fixture = await neutralFixture(t, {
    pluginId: 'official.storage-governance',
    webhookPath: 'scan',
    async conversationStorage(signal) {
      await pending.promise;
      signal.throwIfAborted();
      return empty;
    },
  });
  try {
    const response = await fixture.http('conversationStorage', 'beginRead');
    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(response.json(), { available: true, result: { state: 'running' } });
    const poll = async () => (await fixture.httpGet('conversationStorage', 'getRead')).json().result;
    assert.deepEqual(await poll(), { state: 'running' });
    pending.resolve();
    let result = await poll();
    for (let attempt = 0; attempt < 20 && result?.state === 'running'; attempt++) {
      await sleep(10);
      result = await poll();
    }
    assert.deepEqual(result, { state: 'ready', sources: empty });
    await assert.rejects(fixture.host().conversationStorage.beginRead(), /authenticated owner scan/);
    await assert.rejects(fixture.host().conversationStorage.getRead(), /authenticated owner scan/);
  } finally {
    pending.resolve();
  }
});
