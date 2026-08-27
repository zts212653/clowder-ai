import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import {
  CloudReturnBindingSigner,
  loadOrCreateCloudReturnBindingSigner,
} from '../dist/domains/cats/services/cloud-bridge/cloud-return-binding.js';
import { hydrateReplyPreview, MessageStore } from '../dist/domains/cats/services/stores/ports/MessageStore.js';

const apiRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = join(apiRoot, '..', '..');

describe('F247 source-bound Remote MCP return contract', () => {
  it('requires both post_message variants to bind the reply to runtime sourceMessageId', async () => {
    const instructions = await readFile(join(repoRoot, 'cat-cafe-skills/refs/gpt-pro-custom-instructions.md'), 'utf8');
    assert.match(instructions, /sourceMessageId/);
    assert.match(instructions, /post_message/);
    assert.match(instructions, /cross_post_message/);
    assert.match(instructions, /replyTo:\s*sourceMessageId/);
    assert.match(instructions, /cloudReturnBinding/);
  });

  it('projects a Remote MCP reply against the exact source message through the existing F264 replyTo seam', async () => {
    const store = new MessageStore();
    const source = store.append({
      userId: 'alice',
      catId: 'codex-sol',
      threadId: 'thread-f247-return',
      content: '@gpt-pro inspect this exact source',
      mentions: ['gpt-pro'],
      timestamp: 1_000,
    });
    const remoteReply = store.append({
      userId: 'alice',
      catId: 'gpt-pro',
      threadId: 'thread-f247-return',
      content: 'Remote MCP source-bound response',
      mentions: [],
      timestamp: 1_100,
      replyTo: source.id,
    });

    assert.equal(remoteReply.replyTo, source.id);
    assert.deepEqual(await hydrateReplyPreview(store, remoteReply.replyTo), {
      senderCatId: 'codex-sol',
      content: '@gpt-pro inspect this exact source',
    });
  });

  it('admits independent gpt-pro posts while binding every source-reply attempt', async () => {
    process.env.DEFAULT_OWNER_USER_ID = 'alice';
    const { callbacksRoutes } = await import('../dist/routes/callbacks.js');
    const { InvocationRegistry } = await import(
      '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js'
    );
    const { AgentKeyRegistry } = await import('../dist/domains/cats/services/agents/agent-key/AgentKeyRegistry.js');
    const { ThreadStore } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');
    const signer = new CloudReturnBindingSigner(Buffer.alloc(32, 7));
    const agentKeyRegistry = new AgentKeyRegistry({ ttlMs: 86_400_000 });
    const store = new MessageStore();
    const threadStore = new ThreadStore();
    const thread = await threadStore.create('alice', 'F247 source-bound return');
    await threadStore.addParticipants(thread.id, ['codex']);
    const source = store.append({
      userId: 'alice',
      catId: 'codex-sol',
      threadId: thread.id,
      content: '@gpt-pro bind this source',
      mentions: ['gpt-pro'],
      timestamp: 1_000,
      extra: { stream: { invocationId: 'inv-source', turnInvocationId: 'inv-source' } },
    });
    const other = store.append({
      userId: 'alice',
      catId: 'codex-sol',
      threadId: thread.id,
      content: 'do not bind this source',
      mentions: [],
      timestamp: 1_001,
    });
    const binding = signer.sign({
      threadId: thread.id,
      userId: 'alice',
      sourceMessageId: source.id,
      dispatchInvocationId: 'inv-cloud',
      targetCatId: 'gpt-pro',
    });
    const { secret } = await agentKeyRegistry.issue('gpt-pro', 'alice');
    const app = Fastify();
    await app.register(callbacksRoutes, {
      registry: new InvocationRegistry(),
      agentKeyRegistry,
      cloudReturnBindingSigner: signer,
      messageStore: store,
      threadStore,
      socketManager: { broadcastAgentMessage: () => undefined },
    });

    const proactive = await app.inject({
      method: 'POST',
      url: '/api/callbacks/post-message',
      headers: { 'x-agent-key-secret': secret },
      payload: {
        content: 'independent proactive analysis',
        threadId: thread.id,
        targetCats: ['codex'],
      },
    });
    assert.equal(proactive.statusCode, 200);
    assert.ok(proactive.json().messageId);
    const proactiveStored = (await store.getByThread(thread.id)).find(
      (message) => message.content === 'independent proactive analysis',
    );
    assert.ok(proactiveStored);
    assert.equal(proactiveStored.replyTo, undefined);

    const proactiveReplace = await app.inject({
      method: 'POST',
      url: '/api/callbacks/post-message',
      headers: { 'x-agent-key-secret': secret },
      payload: {
        content: 'must not replace a source without invocation provenance',
        threadId: thread.id,
        streamDisposition: 'replace_final',
      },
    });
    assert.equal(proactiveReplace.statusCode, 400);
    assert.equal(proactiveReplace.json().kind, 'replace_final_agent_key_unsupported');

    const missingBinding = await app.inject({
      method: 'POST',
      url: '/api/callbacks/post-message',
      headers: { 'x-agent-key-secret': secret },
      payload: { content: 'missing binding', threadId: thread.id, replyTo: source.id },
    });
    assert.equal(missingBinding.statusCode, 400);
    assert.equal(missingBinding.json().kind, 'cloud_return_binding_required');

    const missingReplyTo = await app.inject({
      method: 'POST',
      url: '/api/callbacks/post-message',
      headers: { 'x-agent-key-secret': secret },
      payload: { content: 'missing reply source', threadId: thread.id, cloudReturnBinding: binding },
    });
    assert.equal(missingReplyTo.statusCode, 400);
    assert.equal(missingReplyTo.json().kind, 'cloud_return_binding_required');

    const substituted = await app.inject({
      method: 'POST',
      url: '/api/callbacks/post-message',
      headers: { 'x-agent-key-secret': secret },
      payload: {
        content: 'substituted source',
        threadId: thread.id,
        replyTo: other.id,
        cloudReturnBinding: binding,
      },
    });
    assert.equal(substituted.statusCode, 403);
    assert.equal(substituted.json().kind, 'cloud_return_binding_mismatch');

    const accepted = await app.inject({
      method: 'POST',
      url: '/api/callbacks/post-message',
      headers: { 'x-agent-key-secret': secret },
      payload: {
        content: 'bound remote response',
        threadId: thread.id,
        replyTo: source.id,
        cloudReturnBinding: binding,
      },
    });
    assert.equal(accepted.statusCode, 200);
    const stored = (await store.getByThread(thread.id)).find((message) => message.content === 'bound remote response');
    assert.equal(stored.replyTo, source.id);
    await app.close();
  });

  it('rejects a validly signed binding when the gpt-pro principal or target thread does not match', () => {
    const signer = new CloudReturnBindingSigner(Buffer.alloc(32, 9));
    const binding = signer.sign({
      threadId: 'thread-owner',
      userId: 'alice',
      sourceMessageId: 'source-owner',
      dispatchInvocationId: 'inv-cloud',
      targetCatId: 'gpt-pro',
    });

    assert.equal(
      signer.verify(binding, { threadId: 'thread-other', userId: 'alice', targetCatId: 'gpt-pro' }).ok,
      false,
    );
    assert.equal(
      signer.verify(binding, { threadId: 'thread-owner', userId: 'alice', targetCatId: 'other-cloud-cat' }).ok,
      false,
    );
    const tampered = `${binding.slice(0, -1)}${binding.endsWith('A') ? 'B' : 'A'}`;
    assert.equal(
      signer.verify(tampered, { threadId: 'thread-owner', userId: 'alice', targetCatId: 'gpt-pro' }).ok,
      false,
    );
  });

  it('keeps return bindings verifiable across API composition restarts', async () => {
    const values = new Map();
    const redis = {
      async set(key, value, mode) {
        if (mode === 'NX' && values.has(key)) return null;
        values.set(key, value);
        return 'OK';
      },
      async get(key) {
        return values.get(key) ?? null;
      },
    };
    const first = await loadOrCreateCloudReturnBindingSigner(redis);
    const claims = {
      threadId: 'thread-restart',
      userId: 'alice',
      sourceMessageId: 'source-restart',
      dispatchInvocationId: 'inv-restart',
      targetCatId: 'gpt-pro',
    };
    const binding = first.sign(claims);
    const restarted = await loadOrCreateCloudReturnBindingSigner(redis);
    assert.deepEqual(
      restarted.verify(binding, {
        threadId: claims.threadId,
        userId: claims.userId,
        sourceMessageId: claims.sourceMessageId,
        targetCatId: claims.targetCatId,
      }),
      { ok: true, dispatchInvocationId: claims.dispatchInvocationId },
    );
  });
});
