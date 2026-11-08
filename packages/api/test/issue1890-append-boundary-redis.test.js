import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import Fastify from 'fastify';
import { InvocationRegistry } from '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js';
import { RedisQueueLedgerStore } from '../dist/domains/cats/services/agents/invocation/queue-ledger/RedisQueueLedgerStore.js';
import { RedisMessageStore } from '../dist/domains/cats/services/stores/redis/RedisMessageStore.js';
import { MessageKeys } from '../dist/domains/cats/services/stores/redis-keys/message-keys.js';
import { messagesRoutes } from '../dist/routes/messages.js';
import { createCallbackContextFixture } from './helpers/callback-context-fixture.js';
import { ownedRedisFixture } from './helpers/owned-redis-fixture.js';

const owned = ownedRedisFixture('f1890-append-boundary');
const hash = (value) => createHash('sha256').update(value, 'utf8').digest('hex');

async function publishWake(f, caller, content) {
  const from = { kind: 'agent', catId: caller };
  return f.queue.send(
    f.messages,
    {
      userId: f.userId,
      threadId: f.threadId,
      from,
      content,
      mentions: ['opus'],
      timestamp: Date.now(),
    },
    {
      userId: f.userId,
      threadId: f.threadId,
      from,
      content,
      targetCats: ['opus', 'codex'],
      kind: 'message_wake',
      sourceCategory: 'a2a',
      ownerAuthProvenance: 'strict',
      intent: 'execute',
      messageDisposition: 'next_work',
      autoExecute: true,
    },
  );
}

for (const kind of ['conversation_input', 'message_wake']) {
  test(`Redis ${kind} persists one boundary across callback admission, terminal, new client reread, anchor and member drill`, async (t) => {
    const keyPrefix = `f1890-boundary:${kind}:`;
    const writer = owned.client(keyPrefix);
    const store = new RedisMessageStore(writer);
    const ledger = new RedisQueueLedgerStore(writer);
    const f = await createCallbackContextFixture(t, { messageStore: store, ledgerStore: ledger });

    let content = '  Redis initial body\n\n';
    const prefix = content.trimStart();
    const release = f.tracker.bindLifecycleOutputCursor(
      f.threadId,
      'opus',
      { invocationId: f.auth.invocationId, responseMessageId: f.response.id },
      () => content,
    );
    t.after(() => release?.());

    const privateMessage = await store.append({
      userId: f.userId,
      threadId: f.threadId,
      from: { kind: 'user', userId: f.userId },
      content: 'private secret should not become public boundary',
      mentions: [],
      visibility: 'whisper',
      whisperTo: ['codex'],
      timestamp: Date.now(),
    });
    const source =
      kind === 'message_wake'
        ? await publishWake(f, 'codex', 'Redis reviewer request')
        : await f.enqueue('Redis reviewer request');
    const admitted = await f.read();
    assert.equal(admitted.statusCode, 200, admitted.body);
    const expected = [
      {
        inputMessageId: source.message.id,
        contentOffset: prefix.length,
        prefixSha256: hash(prefix),
      },
    ];
    const stored = await store.getById(f.response.id);
    assert.deepEqual(stored.lifecycle.appendBoundaries, expected);
    assert.equal(stored.lifecycle.inputMessageIds.includes(privateMessage.id), false);

    content += 'Redis terminal body';
    const terminal = await store.commitLifecycleResponseTerminal(f.response.id, {
      invocationId: f.auth.invocationId,
      status: 'completed',
      completedAt: Date.now(),
      content,
      mentions: [],
      origin: 'stream',
    });
    assert.ok(terminal.kind === 'applied' || terminal.kind === 'replayed', JSON.stringify(terminal));

    const sourceStored = await store.getById(source.message.id);
    assert.equal(
      sourceStored.lifecycle.dispatchRefs.find((ref) => ref.targetId === 'opus').statusMessageId,
      f.response.id,
    );

    const readerClient = owned.client(keyPrefix);
    const reader = new RedisMessageStore(readerClient);
    const reread = await reader.getById(f.response.id);
    assert.equal(reread.content, content);
    assert.deepEqual(reread.lifecycle.appendBoundaries, expected);
    assert.deepEqual(reread.lifecycle.inputMessageIds, [source.message.id]);
    assert.equal(reread.lifecycle.inputMessageIds.includes(privateMessage.id), false);
    assert.equal(
      (reread.lifecycle.appendBoundaries ?? []).some((b) => b.inputMessageId === privateMessage.id),
      false,
    );
    assert.equal(await writer.pttl(MessageKeys.detail(f.response.id)), -1);

    const full = await f.read();
    assert.equal(full.statusCode, 200, full.body);
    const fullMessages = full.json().messages;
    const responseProjection = fullMessages.find((message) => message.id === f.response.id);
    const sourceProjection = fullMessages.find((message) => message.id === source.message.id);
    assert.ok(responseProjection);
    assert.equal(fullMessages.filter((message) => message.id === f.response.id).length, 1);
    assert.equal(responseProjection.content, content);
    assert.deepEqual(responseProjection.inputMessageIds, [source.message.id]);
    assert.deepEqual(responseProjection.appendBoundaries, expected);
    assert.equal(responseProjection.appendBoundarySemantics, 'host_observed_display_range');
    assert.equal(full.body.includes('private secret should not become public boundary'), false);
    assert.ok(sourceProjection);
    assert.ok(
      (sourceProjection.dispatchRefs ?? []).some(
        (ref) => ref.targetId === 'opus' && ref.statusMessageId === f.response.id,
      ),
    );

    const drill = await f.app.inject({
      method: 'GET',
      url: `/api/callbacks/get-message?messageId=${f.response.id}&mode=full`,
      headers: { 'x-invocation-id': f.auth.invocationId, 'x-callback-token': f.auth.callbackToken },
    });
    assert.equal(drill.statusCode, 200, drill.body);
    assert.deepEqual(drill.json().message.inputMessageIds, responseProjection.inputMessageIds);
    assert.deepEqual(drill.json().message.appendBoundaries, responseProjection.appendBoundaries);

    const anchorApp = Fastify();
    await anchorApp.register(messagesRoutes, {
      registry: new InvocationRegistry(),
      messageStore: reader,
      socketManager: { broadcastAgentMessage() {} },
    });
    await anchorApp.ready();
    t.after(() => anchorApp.close());
    const anchor = await anchorApp.inject({
      method: 'GET',
      url: `/api/messages?${new URLSearchParams({
        threadId: f.threadId,
        anchorMessageId: f.response.id,
        limit: '1',
      })}`,
      headers: { 'x-cat-cafe-user': f.userId },
    });
    assert.equal(anchor.statusCode, 200, anchor.body);
    assert.deepEqual(
      anchor.json().messages.map((message) => message.id),
      [f.response.id],
    );
    assert.equal(anchor.json().messages[0].content, content);
    assert.deepEqual(anchor.json().messages[0].lifecycle.inputMessageIds, [source.message.id]);
    assert.deepEqual(anchor.json().messages[0].lifecycle.appendBoundaries, expected);
  });
}
