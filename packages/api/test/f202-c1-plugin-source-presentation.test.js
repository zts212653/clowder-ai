import assert from 'node:assert/strict';
import { test } from 'node:test';
import Fastify from 'fastify';
import { hydrateReplyPreview, MessageStore } from '../dist/domains/cats/services/stores/ports/MessageStore.js';
import { parsePluginMessageExtra } from '../dist/domains/messaging/envelope.js';
import { pluginMessageSourceOf } from '../dist/domains/plugin/host-surface/plugin-messaging-source.js';
import { messagesRoutes } from '../dist/routes/messages.js';

const manifest = {
  pluginId: 'example.chat',
  name: 'Example Chat',
  icon: { type: 'svg', src: 'assets/chat.svg' },
  contributions: [
    { type: 'identity', id: 'chat-bot', displayName: 'Internal bot', color: '#07c160' },
    { type: 'message-subscription', id: 'chat', binding: 'chat-bot' },
  ],
};
test('external plugin presentation uses package name/icon and declared identity color', () => {
  const { source, sender } = pluginMessageSourceOf(
    manifest,
    { kind: 'external', connectorId: 'chat', sourceAddress: { connectorId: 'chat', chatId: 'route-1' } },
    { sender: { id: 'opaque@provider' } },
  );
  assert.equal(source.label, 'Example Chat');
  assert.equal(source.icon, '/api/plugin-manager/plugins/example.chat/icon');
  assert.equal(source.themeColor, '#07c160');
  assert.equal(sender.id, 'opaque@provider', 'routing identity is preserved');
  const extra = {
    instanceId: 'pi-chat',
    revision: 1,
    provenance: { origin: { kind: 'plugin', instanceId: 'pi-chat' }, epistemicStatus: 'user_intent' },
    elements: [{ elementId: 'text', kind: 'text', payload: { text: 'hi' } }],
    appendOps: [],
    presentation: source,
  };
  assert.deepEqual(parsePluginMessageExtra(extra)?.presentation, source, 'identity survives persisted hydration');
});

function storedConversation() {
  const store = new MessageStore();
  const { source } = pluginMessageSourceOf(
    manifest,
    { kind: 'external', connectorId: 'chat', sourceAddress: { connectorId: 'chat', chatId: 'route-1' } },
    { sender: { id: 'opaque@provider' } },
  );
  const parent = store.append({
    from: { kind: 'plugin', instanceId: 'pi-chat' },
    userId: 'owner',
    threadId: 'thread',
    content: 'hello from the plugin',
    mentions: [],
    timestamp: 1000,
    extra: {
      pluginMessage: parsePluginMessageExtra(
        JSON.parse(
          JSON.stringify({
            instanceId: 'pi-chat',
            revision: 1,
            provenance: { origin: { kind: 'plugin', instanceId: 'pi-chat' }, epistemicStatus: 'user_intent' },
            elements: [{ elementId: 'text', kind: 'text', payload: { text: 'hello from the plugin' } }],
            appendOps: [],
            presentation: source,
          }),
        ),
      ),
    },
  });
  const reply = store.append({
    from: { kind: 'agent', catId: 'opus' },
    userId: 'owner',
    threadId: 'thread',
    content: 'reply',
    mentions: [],
    timestamp: 2000,
    replyTo: parent.id,
  });
  assert.equal(parent.source, undefined, 'plugin identity must come from persisted extra, not a legacy source fixture');
  return { store, parent, reply, source };
}

test('history HTTP response projects persisted plugin identity into bubble and reply rendering inputs', async (t) => {
  const { store, parent, reply, source } = storedConversation();
  const app = Fastify();
  t.after(() => app.close());
  await app.register(messagesRoutes, { messageStore: store, router: {}, registry: {}, socketManager: {} });
  const response = await app.inject({ url: '/api/messages?threadId=thread', headers: { 'x-cat-cafe-user': 'owner' } });
  assert.equal(response.statusCode, 200, response.body);
  const rows = response.json().messages;
  const incoming = rows.find((row) => row.id === parent.id);
  assert.equal(incoming.type, 'connector');
  assert.deepEqual(incoming.source, source);
  const preview = rows.find((row) => row.id === reply.id).replyPreview;
  assert.deepEqual(preview.from, parent.from);
  assert.deepEqual(preview.source, source);
  assert.equal(preview.content, parent.content);
});

test('live reply hydration preserves plugin presentation without sharing stored objects or leaking deleted identity', async () => {
  const { store, parent, source } = storedConversation();
  const preview = await hydrateReplyPreview(store, parent.id);
  assert.deepEqual(preview.source, source);
  preview.source.sender.id = 'mutated';
  preview.source.themeColor = '#ffffff';
  assert.deepEqual((await store.getById(parent.id)).extra.pluginMessage.presentation, source);
  parent.deletedAt = 3000;
  assert.deepEqual(await hydrateReplyPreview(store, parent.id), {
    from: parent.from,
    senderCatId: parent.catId,
    content: '',
    deleted: true,
  });
});
