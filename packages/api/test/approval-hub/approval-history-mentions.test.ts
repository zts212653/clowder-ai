import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MessageStore } from '../../src/domains/cats/services/stores/ports/MessageStore.js';
import { readUserMentionTodos } from '../../src/routes/user-mention-todo-projection.js';
import { canonicalTestMessageInput } from '../helpers/message-from-fixtures.js';

test('ignored history can enumerate older pending and handled mentions without reopening handled requests', async () => {
  const messages = new MessageStore();
  const append = (threadId: string, timestamp: number, userId = 'owner') =>
    messages.append(
      canonicalTestMessageInput({
        userId,
        catId: 'codex61-sol',
        threadId,
        timestamp,
        mentionsUser: true,
        mentions: [],
        content: '@co-creator\n原请求',
      }),
    );
  const old = append('old', 100);
  const handled = append('handled', 200);
  messages.resolveUserMentionRequest('owner', 'handled', handled.id);
  append('other', 300, 'another-owner');
  const options = { now: 30 * 86400000, cutover: 1000, period: 'all' as const };
  const read = await readUserMentionTodos(messages, 'owner', options);
  assert.equal(read.state.status, 'available');
  assert.deepEqual(new Set(read.items.map((item) => item.userMention?.messageId)), new Set([old.id, handled.id]));
  assert.equal(read.items.find((item) => item.userMention?.messageId === old.id)?.userMention?.handled, undefined);
  assert.equal(
    read.items.find((item) => item.userMention?.messageId === handled.id)?.userMention?.handledReason,
    'ignored',
  );
  const revision = messages.getUserMentionStateRevisions('owner').handled;
  assert.equal(await messages.restoreUserMentionRequest('owner', 'handled', handled.id, revision), true);
  const restored = await readUserMentionTodos(messages, 'owner', options);
  assert.equal(restored.items.filter((item) => item.userMention?.messageId === handled.id).length, 1);
  assert.equal(
    restored.items.find((item) => item.userMention?.messageId === handled.id)?.userMention?.handled,
    undefined,
  );
});
