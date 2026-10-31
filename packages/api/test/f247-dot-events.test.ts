import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createCatId } from '@cat-cafe/shared';
import { AgentKeyRegistry } from '../src/domains/cats/services/agents/agent-key/AgentKeyRegistry.js';
import { DotConnectionService } from '../src/domains/cats/services/cloud-bridge/dot/DotConnectionService.js';
import { DotConnectionStore } from '../src/domains/cats/services/cloud-bridge/dot/DotConnectionStore.js';
import { DotDispatchStore } from '../src/domains/cats/services/cloud-bridge/dot/DotDispatchStore.js';
import { DotEventsBridge } from '../src/domains/cats/services/cloud-bridge/dot/DotEventsBridge.js';
import { DotReturnService } from '../src/domains/cats/services/cloud-bridge/dot/DotReturnService.js';
import { MessageStore } from '../src/domains/cats/services/stores/ports/MessageStore.js';
import { ThreadStore } from '../src/domains/cats/services/stores/ports/ThreadStore.js';

test('two simultaneous sources return independently; retries, stale credentials, and self replies cannot duplicate work', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dot-events-'));
  try {
    const messages = new MessageStore();
    const threads = new ThreadStore();
    const keys = new AgentKeyRegistry();
    const connection = new DotConnectionService({
      keys,
      store: new DotConnectionStore(join(directory, 'connection.json')),
      authority: async () => ({ ownerUserId: 'owner', pluginInstanceId: 'dot-instance' }),
      ensureIdentity: async () => {},
      sendWebhook: async (_url, _headers, body) => ({
        status: 200,
        body: JSON.stringify({ challenge: JSON.parse(body).challenge }),
      }),
    });
    const setup = await connection.begin('owner');
    await connection.subscribe(setup.credentialSecret, {
      attemptId: setup.attemptId!,
      pairingCode: setup.pairingCode!,
      url: 'https://example.com/callback',
      secret: `whsec_${Buffer.alloc(32, 7).toString('base64')}`,
    });
    const dispatches = new DotDispatchStore(join(directory, 'dispatches'));
    const received: Array<{ eventId: string; data: { thread_id: string } }> = [];
    const bridge = new DotEventsBridge({
      connection,
      dispatches,
      messageStore: messages,
      threadStore: threads,
      enabled: async () => true,
      sendWebhook: async (_url, _headers, body) => {
        received.push(JSON.parse(body));
        return { status: 202, body: '{}' };
      },
    });
    const sources = ['A', 'B'].map((title) => {
      const thread = threads.create('owner', title);
      const source = messages.append({
        userId: 'owner',
        catId: null,
        threadId: thread.id,
        content: `nonce ${title}`,
        mentions: [],
        timestamp: Date.now(),
      });
      return {
        catId: 'gpt-dot',
        userId: 'owner',
        threadId: thread.id,
        sourceMessageId: source.id,
        content: source.content,
        dispatchInvocationId: `invocation-${title}`,
      };
    });
    await Promise.all(sources.map((source) => bridge.dispatch(source)));
    assert.equal(received.length, 2);
    assert.equal((await connection.status()).replyAt, null, '2xx is receipt, not a reply');
    const eventA = received.find((event) => event.data.thread_id === sources[0]!.threadId)!;
    const eventB = received.find((event) => event.data.thread_id === sources[1]!.threadId)!;
    let writes = 0;
    let writing = false;
    const returns = new DotReturnService({
      connection,
      dispatches,
      messages,
      threads,
      postReply: async ({ threadId, sourceMessageId }) => {
        if (writing) throw new Error('cloud_return_grant_in_flight');
        writing = true;
        await new Promise((resolve) => setTimeout(resolve, 10));
        writes++;
        writing = false;
        return { messageId: `${threadId}:${sourceMessageId}` };
      },
    });
    await assert.rejects(() => returns.reply(setup.credentialSecret, eventA.eventId, 'first'), /source_not_read/);
    const readB = await returns.read(setup.credentialSecret, eventB.eventId);
    assert.equal(readB.source.content, 'nonce B');
    const [b, duplicateB] = await Promise.all([
      returns.reply(setup.credentialSecret, eventB.eventId, 'B reply'),
      returns.reply(setup.credentialSecret, eventB.eventId, 'concurrent image reply'),
    ]);
    assert.equal(b.messageId, duplicateB.messageId);
    await returns.read(setup.credentialSecret, eventA.eventId);
    const a = await returns.reply(setup.credentialSecret, eventA.eventId, 'A reply');
    assert.notEqual(a.messageId, b.messageId);
    assert.equal((await returns.reply(setup.credentialSecret, eventA.eventId, 'changed retry')).messageId, a.messageId);
    assert.equal(writes, 2);
    await bridge.dispatch(sources[0]!);
    assert.equal(received.length, 2, 'successful webhook retry does not send a new event');
    const restarted = new DotReturnService({
      connection,
      dispatches: new DotDispatchStore(join(directory, 'dispatches')),
      messages,
      threads,
      postReply: async () => {
        throw new Error('must not write');
      },
    });
    assert.equal((await restarted.reply(setup.credentialSecret, eventA.eventId, 'retry')).messageId, a.messageId);
    const catSource = messages.append({
      userId: 'owner',
      catId: createCatId('codex61-sol'),
      threadId: sources[0]!.threadId,
      content: 'ordinary housecat',
      mentions: [],
      timestamp: Date.now(),
    });
    const catDispatch = { ...sources[0]!, sourceMessageId: catSource.id, dispatchInvocationId: 'cat-dispatch' };
    assert.equal((await bridge.dispatch(catDispatch)).kind, 'sent');
    const catEvent = received.at(-1)!;
    await returns.read(setup.credentialSecret, catEvent.eventId);
    const catReply = await returns.reply(setup.credentialSecret, catEvent.eventId, 'housecat reply');
    assert.equal(catReply.messageId, `${catSource.threadId}:${catSource.id}`);
    const self = messages.append({
      userId: 'owner',
      catId: createCatId('gpt-dot'),
      threadId: sources[0]!.threadId,
      content: 'self',
      mentions: [],
      timestamp: Date.now(),
    });
    const sentCount = received.length;
    assert.equal((await bridge.dispatch({ ...catDispatch, sourceMessageId: self.id })).kind, 'fallback');
    assert.equal(received.length, sentCount, 'dot cannot trigger its own callback loop');
    await connection.begin('owner', true);
    await assert.rejects(() => returns.read(setup.credentialSecret, eventA.eventId), /credential_rejected/);
    assert.equal((await connection.status()).replyAt, null, 'new pairing must prove its own roundtrip');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
