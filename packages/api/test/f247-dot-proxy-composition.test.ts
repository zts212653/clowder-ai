import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { AgentKeyRegistry } from '../src/domains/cats/services/agents/agent-key/AgentKeyRegistry.js';
import { DotConnectionService } from '../src/domains/cats/services/cloud-bridge/dot/DotConnectionService.js';
import { DotConnectionStore } from '../src/domains/cats/services/cloud-bridge/dot/DotConnectionStore.js';
import { DotDispatchStore } from '../src/domains/cats/services/cloud-bridge/dot/DotDispatchStore.js';
import { DotEventsBridge } from '../src/domains/cats/services/cloud-bridge/dot/DotEventsBridge.js';
import { createDotWebhookSender } from '../src/domains/cats/services/cloud-bridge/dot/dot-webhook.js';
import { MessageStore } from '../src/domains/cats/services/stores/ports/MessageStore.js';
import { ThreadStore } from '../src/domains/cats/services/stores/ports/ThreadStore.js';
import { dotProxyFixture } from './helpers/dot-proxy-tls-fixture.js';

test('shared proxy sender admits a verified subscription, preserves failure state, and sends both source events', async () => {
  const f = await dotProxyFixture();
  const directory = await mkdtemp(join(tmpdir(), 'dot-proxy-composition-'));
  try {
    const sendWebhook = createDotWebhookSender(f.proxyUrl);
    const store = new DotConnectionStore(join(directory, 'connection.json'));
    const connection = new DotConnectionService({
      keys: new AgentKeyRegistry(),
      store,
      authority: async () => ({ ownerUserId: 'owner', pluginInstanceId: 'dot-instance' }),
      ensureIdentity: async () => {},
      sendWebhook,
    });
    const setup = await connection.begin('owner');
    assert.ok(setup.attemptId);
    assert.ok(setup.pairingCode);
    const input = {
      attemptId: setup.attemptId,
      pairingCode: setup.pairingCode,
      url: 'https://callback.example.com/events',
      secret: `whsec_${Buffer.alloc(32, 7).toString('base64')}`,
    };
    f.settings.aaaa = ['::1'];
    await assert.rejects(() => connection.subscribe(setup.credentialSecret, input), /private\/reserved/);
    assert.equal((await connection.status()).paired, false);
    assert.equal((await store.read())?.subscription, null);
    assert.equal(f.callbacks.length, 0);
    f.settings.aaaa = [];
    const first = await connection.subscribe(setup.credentialSecret, input);
    const again = await connection.subscribe(setup.credentialSecret, input);
    assert.equal(first.id, again.id);
    assert.equal(f.callbacks.length, 1, 'duplicate subscription never sends another challenge');
    const messages = new MessageStore();
    const threads = new ThreadStore();
    const bridge = new DotEventsBridge({
      connection,
      dispatches: new DotDispatchStore(join(directory, 'dispatches')),
      messageStore: messages,
      threadStore: threads,
      enabled: async () => true,
      sendWebhook,
    });
    const sources = ['A', 'B'].map((title) => {
      const thread = threads.create('owner', title);
      const source = messages.append({
        userId: 'owner',
        from: { kind: 'user', userId: 'owner' },
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
    const events = f.callbacks.slice(1).map((callback) => JSON.parse(callback.body));
    assert.equal(events.length, 2);
    assert.deepEqual(
      events.map((event) => event.data.thread_id).sort(),
      sources.map((source) => source.threadId).sort(),
    );
    assert.equal((await connection.status()).replyAt, null, 'local event receipts cannot prove provider replies');
    assert.equal((await connection.status()).imageAt, null);
    assert.ok(f.connects.every((target) => ['dns.google:443', '93.184.216.34:443'].includes(target)));
  } finally {
    await f.close();
    await rm(directory, { recursive: true, force: true });
  }
});
