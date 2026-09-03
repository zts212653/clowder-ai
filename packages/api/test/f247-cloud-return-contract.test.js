import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import {
  CloudReturnBindingSigner,
  loadOrCreateCloudReturnBindingSigner,
} from '../dist/domains/cats/services/cloud-bridge/cloud-return-binding.js';
import { MemoryCloudReturnGrantStore } from '../dist/domains/cats/services/cloud-bridge/cloud-return-grant.js';
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
    assert.doesNotMatch(instructions, /cloudReturnBinding/);
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
    const grantStore = new MemoryCloudReturnGrantStore();
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
    await grantStore.issue({
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
      cloudReturnGrantStore: grantStore,
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
      },
    });
    assert.equal(substituted.statusCode, 403);
    assert.equal(substituted.json().kind, 'cloud_return_grant_not_found');

    const accepted = await app.inject({
      method: 'POST',
      url: '/api/callbacks/post-message',
      headers: { 'x-agent-key-secret': secret },
      payload: {
        content: 'bound remote response',
        threadId: thread.id,
        replyTo: source.id,
      },
    });
    assert.equal(accepted.statusCode, 200);
    const stored = (await store.getByThread(thread.id)).find((message) => message.content === 'bound remote response');
    assert.equal(stored.replyTo, source.id);

    const consumedReplay = await app.inject({
      method: 'POST',
      url: '/api/callbacks/post-message',
      headers: { 'x-agent-key-secret': secret },
      payload: { content: 'different replay', threadId: thread.id, replyTo: source.id },
    });
    assert.equal(consumedReplay.statusCode, 200);
    assert.equal(consumedReplay.json().status, 'duplicate');
    assert.equal(consumedReplay.json().messageId, stored.id);
    assert.equal((await store.getByThread(thread.id)).filter((message) => message.replyTo === source.id).length, 1);
    await app.close();
  });

  it('recovers a durable source reply before reapplying mutable concierge admission', async () => {
    process.env.DEFAULT_OWNER_USER_ID = 'alice';
    const { callbacksRoutes } = await import('../dist/routes/callbacks.js');
    const { InvocationRegistry } = await import(
      '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js'
    );
    const { AgentKeyRegistry } = await import('../dist/domains/cats/services/agents/agent-key/AgentKeyRegistry.js');
    const { ThreadStore } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');
    const agentKeyRegistry = new AgentKeyRegistry({ ttlMs: 86_400_000 });
    const grantStore = new MemoryCloudReturnGrantStore();
    const store = new MessageStore();
    const threadStore = new ThreadStore();
    const thread = await threadStore.create('alice', 'F247 durable recovery before mutable admission');
    thread.threadKind = 'concierge';
    const source = store.append({
      userId: 'alice',
      catId: 'codex-sol',
      threadId: thread.id,
      content: '@gpt-pro return to this exact source',
      mentions: ['gpt-pro'],
      timestamp: 1_000,
    });
    await grantStore.issue({
      threadId: thread.id,
      userId: 'alice',
      sourceMessageId: source.id,
      dispatchInvocationId: 'inv-durable-before-admission',
      targetCatId: 'gpt-pro',
    });
    let dutyCatProfileId = 'opus';
    const conciergeConfigStore = {
      get: async () => ({ dutyCatProfileId }),
    };
    const { secret } = await agentKeyRegistry.issue('gpt-pro', 'alice');
    const app = Fastify();
    await app.register(callbacksRoutes, {
      registry: new InvocationRegistry(),
      agentKeyRegistry,
      cloudReturnGrantStore: grantStore,
      messageStore: store,
      threadStore,
      conciergeConfigStore,
      socketManager: { broadcastAgentMessage: () => undefined },
    });
    const payload = {
      content: '[跳过去 R2｜已持久化目标｜thread-durable-target]',
      threadId: thread.id,
      replyTo: source.id,
    };

    const accepted = await app.inject({
      method: 'POST',
      url: '/api/callbacks/post-message',
      headers: { 'x-agent-key-secret': secret },
      payload,
    });
    assert.equal(accepted.statusCode, 200);
    assert.ok(accepted.json().messageId);

    dutyCatProfileId = 'gpt-pro';
    const retried = await app.inject({
      method: 'POST',
      url: '/api/callbacks/post-message',
      headers: { 'x-agent-key-secret': secret },
      payload,
    });
    assert.equal(retried.statusCode, 200, 'durable recovery must not be re-gated by mutable concierge ownership');
    assert.equal(retried.json().status, 'duplicate');
    assert.equal(retried.json().messageId, accepted.json().messageId);
    assert.equal((await store.getByThread(thread.id)).filter((message) => message.replyTo === source.id).length, 1);
    await app.close();
  });

  it('does not consume clientMessageId while an exact return grant is retryably in flight', async () => {
    process.env.DEFAULT_OWNER_USER_ID = 'alice';
    const { callbacksRoutes } = await import('../dist/routes/callbacks.js');
    const { InvocationRegistry } = await import(
      '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js'
    );
    const { AgentKeyRegistry } = await import('../dist/domains/cats/services/agents/agent-key/AgentKeyRegistry.js');
    const { ThreadStore } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');
    const agentKeyRegistry = new AgentKeyRegistry({ ttlMs: 86_400_000 });
    const grantStore = new MemoryCloudReturnGrantStore();
    const store = new MessageStore();
    const threadStore = new ThreadStore();
    const thread = await threadStore.create('alice', 'F247 retryable grant claim');
    const source = store.append({
      userId: 'alice',
      catId: 'codex-sol',
      threadId: thread.id,
      content: '@gpt-pro retry this exact source',
      mentions: ['gpt-pro'],
      timestamp: 1_000,
    });
    const scope = {
      threadId: thread.id,
      userId: 'alice',
      sourceMessageId: source.id,
      targetCatId: 'gpt-pro',
    };
    await grantStore.issue({ ...scope, dispatchInvocationId: 'inv-retryable-grant' });
    const heldClaim = await grantStore.claim(scope);
    assert.equal(heldClaim.ok, true);
    const { secret } = await agentKeyRegistry.issue('gpt-pro', 'alice');
    const app = Fastify();
    await app.register(callbacksRoutes, {
      registry: new InvocationRegistry(),
      agentKeyRegistry,
      cloudReturnGrantStore: grantStore,
      messageStore: store,
      threadStore,
      socketManager: { broadcastAgentMessage: () => undefined },
    });
    const payload = {
      content: 'retryable exact return',
      threadId: thread.id,
      replyTo: source.id,
      clientMessageId: 'f247-retryable-client-id',
    };
    const blocked = await app.inject({
      method: 'POST',
      url: '/api/callbacks/post-message',
      headers: { 'x-agent-key-secret': secret },
      payload,
    });
    assert.equal(blocked.statusCode, 409);
    assert.equal(blocked.json().kind, 'cloud_return_grant_in_flight');

    assert.equal(await grantStore.release(heldClaim), true);
    const retried = await app.inject({
      method: 'POST',
      url: '/api/callbacks/post-message',
      headers: { 'x-agent-key-secret': secret },
      payload,
    });
    assert.equal(retried.statusCode, 200);
    assert.ok(retried.json().messageId);
    assert.equal((await store.getById(retried.json().messageId)).content, payload.content);
    await app.close();
  });

  it('continues delivery after a post-append grant commit error and recovers the durable source reply', async () => {
    process.env.DEFAULT_OWNER_USER_ID = 'alice';
    const { callbacksRoutes } = await import('../dist/routes/callbacks.js');
    const { InvocationRegistry } = await import(
      '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js'
    );
    const { AgentKeyRegistry } = await import('../dist/domains/cats/services/agents/agent-key/AgentKeyRegistry.js');
    const { ThreadStore } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');
    const agentKeyRegistry = new AgentKeyRegistry({ ttlMs: 86_400_000 });
    const backingGrantStore = new MemoryCloudReturnGrantStore();
    let failCommit = true;
    const grantStore = {
      issue: (claims) => backingGrantStore.issue(claims),
      claim: (scope) => backingGrantStore.claim(scope),
      commit: async (claim) => {
        if (failCommit) {
          failCommit = false;
          throw new Error('transient grant commit failure');
        }
        return backingGrantStore.commit(claim);
      },
      release: (claim) => backingGrantStore.release(claim),
    };
    const store = new MessageStore();
    const threadStore = new ThreadStore();
    const thread = await threadStore.create('alice', 'F247 commit recovery');
    const source = store.append({
      userId: 'alice',
      catId: 'codex-sol',
      threadId: thread.id,
      content: '@gpt-pro persist then recover this source',
      mentions: ['gpt-pro'],
      timestamp: 1_000,
    });
    await grantStore.issue({
      threadId: thread.id,
      userId: 'alice',
      sourceMessageId: source.id,
      dispatchInvocationId: 'inv-commit-recovery',
      targetCatId: 'gpt-pro',
    });
    const { secret } = await agentKeyRegistry.issue('gpt-pro', 'alice');
    const broadcasts = [];
    const app = Fastify();
    await app.register(callbacksRoutes, {
      registry: new InvocationRegistry(),
      agentKeyRegistry,
      cloudReturnGrantStore: grantStore,
      messageStore: store,
      threadStore,
      socketManager: { broadcastAgentMessage: (message) => broadcasts.push(message) },
    });
    const payload = {
      content: 'durable exact return despite transient commit failure',
      threadId: thread.id,
      replyTo: source.id,
      clientMessageId: 'f247-commit-recovery-client-id',
    };
    const accepted = await app.inject({
      method: 'POST',
      url: '/api/callbacks/post-message',
      headers: { 'x-agent-key-secret': secret },
      payload,
    });
    assert.equal(accepted.statusCode, 200);
    assert.ok(accepted.json().messageId);
    assert.equal(broadcasts.length, 1);

    const retried = await app.inject({
      method: 'POST',
      url: '/api/callbacks/post-message',
      headers: { 'x-agent-key-secret': secret },
      payload,
    });
    assert.equal(retried.statusCode, 200);
    assert.equal(retried.json().status, 'duplicate');
    assert.equal(retried.json().messageId, accepted.json().messageId);
    const sourceReplies = (await store.getByThread(thread.id)).filter((message) => message.replyTo === source.id);
    assert.equal(sourceReplies.length, 1);
    await app.close();
  });

  it('recovers a queued durable source reply from persisted routing instead of retry input', async () => {
    process.env.DEFAULT_OWNER_USER_ID = 'alice';
    const { callbacksRoutes } = await import('../dist/routes/callbacks.js');
    const { InvocationRegistry } = await import(
      '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js'
    );
    const { InvocationQueue } = await import('../dist/domains/cats/services/agents/invocation/InvocationQueue.js');
    const { AgentKeyRegistry } = await import('../dist/domains/cats/services/agents/agent-key/AgentKeyRegistry.js');
    const { ThreadStore } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');
    const agentKeyRegistry = new AgentKeyRegistry({ ttlMs: 86_400_000 });
    const grantStore = new MemoryCloudReturnGrantStore();
    const store = new MessageStore();
    const threadStore = new ThreadStore();
    const thread = await threadStore.create('alice', 'F247 durable routing recovery');
    const source = store.append({
      userId: 'alice',
      catId: 'codex-sol',
      threadId: thread.id,
      content: '@gpt-pro persist routing for this source',
      mentions: ['gpt-pro'],
      timestamp: 1_000,
    });
    const scope = {
      threadId: thread.id,
      userId: 'alice',
      sourceMessageId: source.id,
      targetCatId: 'gpt-pro',
    };
    const idempotencyKey = `f247-cloud-return:${createHash('sha256')
      .update(JSON.stringify({ v: 1, ...scope }))
      .digest('hex')}`;
    const persisted = store.append({
      userId: 'alice',
      catId: 'gpt-pro',
      threadId: thread.id,
      content: 'original persisted return',
      mentions: ['codex'],
      origin: 'callback',
      timestamp: 1_100,
      extra: { isExplicitPost: true, targetCats: ['codex'] },
      replyTo: source.id,
      deliveryStatus: 'queued',
      idempotencyKey,
    });
    const invocationQueue = new InvocationQueue();
    const queueProcessor = {
      async onInvocationComplete() {},
      async tryAutoExecute() {},
      registerEntryCompleteHook() {},
      unregisterEntryCompleteHook() {},
    };
    const invocationRecordStore = {
      create: () => ({ outcome: 'created', invocationId: 'inv-f247-durable-recovery' }),
      update: () => undefined,
    };
    const router = {
      async *routeExecution() {
        yield { type: 'done', catId: 'codex', isFinal: true, timestamp: Date.now() };
      },
    };
    const broadcasts = [];
    const { secret } = await agentKeyRegistry.issue('gpt-pro', 'alice');
    const app = Fastify();
    await app.register(callbacksRoutes, {
      registry: new InvocationRegistry(),
      agentKeyRegistry,
      cloudReturnGrantStore: grantStore,
      messageStore: store,
      threadStore,
      socketManager: {
        broadcastAgentMessage: (message) => broadcasts.push(message),
        emitToUser: () => undefined,
      },
      invocationQueue,
      queueProcessor,
      invocationRecordStore,
      router,
    });

    const retry = await app.inject({
      method: 'POST',
      url: '/api/callbacks/post-message',
      headers: { 'x-agent-key-secret': secret },
      payload: {
        content: 'regenerated retry body with no routing',
        threadId: thread.id,
        replyTo: source.id,
      },
    });

    assert.equal(retry.statusCode, 200);
    assert.equal(retry.json().status, 'duplicate');
    assert.equal(retry.json().messageId, persisted.id);
    const entries = invocationQueue.list(thread.id, 'alice');
    assert.equal(entries.length, 1);
    assert.equal(entries[0].messageId, persisted.id);
    assert.deepEqual(entries[0].targetCats, ['codex']);
    assert.equal(entries[0].content, persisted.content);
    assert.equal(broadcasts.length, 0);
    assert.equal((await store.getById(persisted.id)).replyTo, source.id);
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

  it('releases the server grant when durable message append fails', async () => {
    process.env.DEFAULT_OWNER_USER_ID = 'alice';
    const { callbacksRoutes } = await import('../dist/routes/callbacks.js');
    const { InvocationRegistry } = await import(
      '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js'
    );
    const { AgentKeyRegistry } = await import('../dist/domains/cats/services/agents/agent-key/AgentKeyRegistry.js');
    const { ThreadStore } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');
    const agentKeyRegistry = new AgentKeyRegistry({ ttlMs: 86_400_000 });
    const grantStore = new MemoryCloudReturnGrantStore();
    const store = new MessageStore();
    const threadStore = new ThreadStore();
    const thread = await threadStore.create('alice', 'F247 append rollback');
    const source = store.append({
      userId: 'alice',
      catId: 'codex-sol',
      threadId: thread.id,
      content: '@gpt-pro return after durable append',
      mentions: ['gpt-pro'],
      timestamp: 1_000,
    });
    await grantStore.issue({
      threadId: thread.id,
      userId: 'alice',
      sourceMessageId: source.id,
      dispatchInvocationId: 'inv-append-rollback',
      targetCatId: 'gpt-pro',
    });
    const { secret } = await agentKeyRegistry.issue('gpt-pro', 'alice');
    const originalAppend = store.append.bind(store);
    store.append = () => {
      throw new Error('durable append failed');
    };

    const app = Fastify();
    await app.register(callbacksRoutes, {
      registry: new InvocationRegistry(),
      agentKeyRegistry,
      cloudReturnGrantStore: grantStore,
      messageStore: store,
      threadStore,
      socketManager: { broadcastAgentMessage: () => undefined },
    });
    const retryPayload = { content: 'same retry after append recovery', threadId: thread.id, replyTo: source.id };
    const failed = await app.inject({
      method: 'POST',
      url: '/api/callbacks/post-message',
      headers: { 'x-agent-key-secret': secret },
      payload: retryPayload,
    });
    assert.equal(failed.statusCode, 500);

    store.append = originalAppend;
    const retried = await app.inject({
      method: 'POST',
      url: '/api/callbacks/post-message',
      headers: { 'x-agent-key-secret': secret },
      payload: retryPayload,
    });
    assert.equal(retried.statusCode, 200);
    assert.ok(retried.json().messageId);
    assert.equal((await store.getById(retried.json().messageId)).replyTo, source.id);
    await app.close();
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
