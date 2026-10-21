import assert from 'node:assert/strict';
import { test } from 'node:test';
import { neutralFixture } from './helpers/neutral-host-fixture.js';

test('installed plugins use ordinary messages and injected actions without parallel Collective authority ports', async (t) => {
  const f = await neutralFixture(t, { capabilities: ['thread.readContent'] });
  for (const name of [
    'publicInvocations',
    'sourceFacts',
    'nativeContext',
    'participantRoster',
    'ownerThreads',
    'custody',
    'deployment',
    'frustration',
    'browserServices',
  ]) {
    assert.equal(Object.hasOwn(f.host(), name), false, `${name} must not remain a public Host port`);
  }
  assert.equal(typeof f.host().messaging.send, 'function');
  assert.equal(typeof f.host().threads.readMessages, 'function');
});

test('members reads the same global directory without contribution-specific eligibility', async (t) => {
  const members = {
    listCats: () => [
      { catId: 'a', displayName: 'A', defaultModel: 'model', avatar: '/private/avatar.png' },
      { catId: 'b', displayName: 'B', defaultModel: 'other', nickname: 'Bee' },
    ],
    publicAvatar: async (path) => (path ? 'https://example.test/avatar.png' : undefined),
    isCatAvailable: (id) => id === 'a',
  };
  const f = await neutralFixture(t, { capabilities: ['thread.listMetadata'], members });
  assert.deepEqual(await f.host().members.list(), [
    { catId: 'a', displayName: 'A', defaultModel: 'model', avatar: 'https://example.test/avatar.png', available: true },
    { catId: 'b', displayName: 'B', defaultModel: 'other', nickname: 'Bee', available: false },
  ]);
  assert.equal((await f.host().members.get('b')).nickname, 'Bee');
  assert.equal(await f.host().members.get('missing'), null);
  const noGrant = await neutralFixture(t, { capabilities: [], members });
  await assert.rejects(() => noGrant.host().members.list(), /capability/);
  await f.runtime.shutdown('test_stop');
  await assert.rejects(() => f.host().members.list(), /current/);
});
