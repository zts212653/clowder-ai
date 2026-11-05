import assert from 'node:assert/strict';
import { test } from 'node:test';
import { catRegistry, createCatId, createCompanionIdentitySnapshot } from '@cat-cafe/shared';
import { MessageStore } from '../dist/domains/cats/services/stores/ports/MessageStore.js';
import { CompanionConversationHistory } from '../dist/domains/concierge/live/host/companion-conversation-history.js';
import { readCompanionConversation } from '../dist/domains/concierge/live/host/companion-conversation-read.js';

const authors = [
  { id: 'history-named', displayName: '缅因猫', nickname: '  砚砚  ', expected: '砚砚' },
  { id: 'history-other', displayName: '布偶猫', nickname: '宪宪', expected: '宪宪' },
  { id: 'history-no-nickname', displayName: '暹罗猫', nickname: undefined, expected: '暹罗猫' },
  { id: 'history-blank-nickname', displayName: '狸花猫', nickname: ' \t ', expected: '狸花猫' },
  { id: 'history-long-name', displayName: '猫', nickname: '名'.repeat(300), expected: '名'.repeat(256) },
];
const template = catRegistry.getOrThrow('codex').config;
for (const author of authors) {
  catRegistry.register(author.id, {
    ...template,
    id: createCatId(author.id),
    displayName: author.displayName,
    nickname: author.nickname,
  });
}

const savedIdentity = createCompanionIdentitySnapshot({
  duty: { catId: 'history-other', displayName: '当时的另一位陪伴猫' },
  carrier: { catId: 'history-named', displayName: '当时的快端' },
  skin: 'black-cat',
  liveTransport: { kind: 'gpt_live_v3', verifiedModel: null },
});

function fixture() {
  const messages = new MessageStore();
  const expected = [];
  let savedMessageId;
  for (const author of [...authors, { id: 'history-unregistered', expected: 'history-unregistered' }, null]) {
    const row = messages.append({
      userId: 'owner',
      threadId: 'home',
      from: author ? { kind: 'agent', catId: createCatId(author.id) } : { kind: 'user', userId: 'owner' },
      content: 'Original author reply',
      mentions: [],
      timestamp: 100 + expected.length,
    });
    if (author?.id === 'history-named') {
      row.extra = { liveCompanion: { identity: savedIdentity } };
      savedMessageId = row.id;
    }
    expected.push({ id: row.id, name: author?.expected ?? '你' });
  }
  const client = {
    async request(path) {
      if (path === '/api/threads/home') return { title: 'Original authors' };
      assert.equal(path, '/api/messages?threadId=home&limit=32');
      return {
        messages: messages.getByThread('home', 32, 'owner').map((message) => ({
          ...message,
          type: message.catId ? 'assistant' : 'user',
        })),
        hasMore: false,
      };
    },
  };
  return { messages, client, expected, savedMessageId };
}

for (const version of ['v1', 'v1-with-saved-identity', 'v2']) {
  test(`${version} labels each original author by nickname with honest fallbacks`, async () => {
    const f = fixture();
    const options = { client: f.client, conversationThread: async () => 'home' };
    const page =
      version === 'v2'
        ? await new CompanionConversationHistory({
            ...options,
            messages: f.messages,
            ownerUserId: 'owner',
            assertCurrent: async () => {},
            verifyThread: async (threadId) => threadId === 'home',
          }).readPage()
        : await readCompanionConversation({ ...options, includeSavedIdentity: version !== 'v1' });
    assert.equal(page.kind, 'conversation');
    assert.deepEqual(
      page.messages.map(({ id, name }) => ({ id, name })),
      f.expected,
      'another companion or saved partner must not replace the original message author',
    );
    assert.deepEqual(
      page.messages.find((row) => row.id === f.savedMessageId).companionIdentity,
      version === 'v1' ? undefined : savedIdentity,
      'existing historical identity metadata stays intact',
    );
  });
}
