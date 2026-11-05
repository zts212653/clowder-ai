/** Canonical plugin membership and external sender presentation are separate facts. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { InvocationQueue } from '../dist/domains/cats/services/agents/invocation/InvocationQueue.js';
import { storedMessageSource } from '../dist/domains/cats/services/stores/message-source.js';
import { MessageStore } from '../dist/domains/cats/services/stores/ports/MessageStore.js';

for (const sender of [{ id: 'ou_alice', name: 'Alice' }, { id: 'ou_bob', name: 'Bob' }, undefined]) {
  test(`plugin admission preserves ${sender?.id ?? 'absent sender'} without making it an authorization identity`, async () => {
    const messages = new MessageStore();
    const queue = new InvocationQueue();
    const presentation = { connector: 'feishu', label: 'Team', ...(sender ? { sender } : {}) };
    const source = messages.append({
      userId: 'owner',
      threadId: 'thread',
      from: { kind: 'plugin', instanceId: 'instance' },
      content: 'hello',
      mentions: [],
      timestamp: Date.now(),
      extra: {
        pluginMessage: {
          instanceId: 'instance',
          revision: 1,
          presentation,
          provenance: { origin: { kind: 'plugin', instanceId: 'instance' }, epistemicStatus: 'observation' },
          elements: [],
          appendOps: [],
        },
      },
    });
    await queue.enqueueExistingMessageDurable(messages, source.id, {
      userId: 'owner',
      threadId: 'thread',
      from: source.from,
      sourceId: source.id,
      messageId: source.id,
      kind: 'conversation_input',
      content: source.content,
      targetCats: ['opus'],
      intent: 'execute',
      ownerAuthProvenance: 'unknown',
      autoExecute: true,
    });
    const stored = messages.getById(source.id);
    const [entry] = queue.list('thread', 'owner');
    assert.deepEqual(stored.from, { kind: 'plugin', instanceId: 'instance' });
    assert.deepEqual(entry.from, stored.from);
    assert.deepEqual(storedMessageSource(stored), presentation);
    assert.deepEqual(storedMessageSource(stored).sender, sender);
    assert.equal(stored.source, undefined);
  });
}
