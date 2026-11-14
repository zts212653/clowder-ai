import assert from 'node:assert/strict';
import test from 'node:test';
import type { MessageFrom } from '@cat-cafe/shared';
import { createPluginMessagingHost } from '../src/domains/plugin/host-surface/plugin-messaging-host.js';

function fixture(from?: MessageFrom) {
  const message = {
    id: 'reply',
    threadId: 'mailbox',
    userId: 'owner',
    catId: null,
    content: 'ordinary reply',
    mentions: [],
    timestamp: 1234,
    deliveryStatus: 'delivered',
    replyTo: 'original',
    ...(from ? { from } : {}),
  };
  const host = createPluginMessagingHost({
    pluginId: 'game',
    pluginInstanceId: 'game-instance',
    ownerUserId: 'owner',
    manifest: {} as never,
    messageStore: { getById: async () => message } as never,
    threadStore: { get: async () => ({ id: 'mailbox' }) } as never,
    messaging: {} as never,
  });
  return { host, message };
}

async function readAuthor(host: ReturnType<typeof createPluginMessagingHost>) {
  const value = await host.get('reply');
  assert.ok(value);
  return value.from;
}

test('Host reads distinguish canonical owner replies from system and plugin rows with the same display identity', async () => {
  for (const from of [
    { kind: 'user', userId: 'owner' },
    { kind: 'system', service: 'scheduler-private' },
    { kind: 'plugin', instanceId: 'other-plugin-private' },
  ] satisfies MessageFrom[]) {
    const f = fixture(from);
    const value = await f.host.get('reply');
    assert.ok(value);
    assert.equal(value.userId, 'owner');
    assert.equal(value.catId, null);
    assert.deepEqual(value.from, from.kind === 'user' ? from : { kind: from.kind });
    assert.equal(
      JSON.stringify(value).includes('-private'),
      false,
      'sender proof exposes no service or installation identifiers',
    );
  }
});

test('canonical sender overrides presentation while legacy rows use the existing canonical resolver', async () => {
  const f = fixture({ kind: 'user', userId: 'owner' });
  Object.assign(f.message, { source: { connector: 'game', label: 'Game computer' } });
  assert.deepEqual(await readAuthor(f.host), { kind: 'user', userId: 'owner' });
  delete f.message.from;
  assert.deepEqual(await readAuthor(f.host), { kind: 'external' });
  const agent = fixture({ kind: 'agent', catId: 'codex61-sol' });
  Object.assign(agent.message, { catId: 'codex61-sol' });
  assert.deepEqual(await readAuthor(agent.host), { kind: 'agent', catId: 'codex61-sol' });
});

test('sender proof does not make hidden or foreign messages readable and is a detached projection', async () => {
  const f = fixture({ kind: 'user', userId: 'owner' });
  const value = await f.host.get('reply');
  assert.ok(value);
  const author = value.from;
  assert.deepEqual(author, { kind: 'user', userId: 'owner' });
  Reflect.set(author, 'userId', 'forged');
  assert.deepEqual(await readAuthor(f.host), { kind: 'user', userId: 'owner' });
  f.message.userId = 'foreign';
  assert.equal(await f.host.get('reply'), null);
  f.message.userId = 'owner';
  Object.assign(f.message, { deletedAt: 1 });
  assert.equal(await f.host.get('reply'), null);
});
