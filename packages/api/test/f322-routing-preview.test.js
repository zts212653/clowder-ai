import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import Fastify from 'fastify';
import { migrateRouterOpts } from './helpers/agent-registry-helpers.js';

function service(catId) {
  return {
    async *invoke() {
      yield { type: 'done', catId, timestamp: Date.now() };
    },
  };
}

function registry() {
  return {
    create: () => ({ invocationId: 'inv-preview', callbackToken: 'token-preview' }),
    verify: async () => ({ ok: false, reason: 'unknown_invocation' }),
  };
}

async function createRouter(threadStore, messageStore) {
  const { AgentRouter } = await import('../dist/domains/cats/services/agents/routing/AgentRouter.js');
  return new AgentRouter(
    await migrateRouterOpts({
      claudeService: service('opus'),
      codexService: service('codex'),
      geminiService: service('gemini'),
      registry: registry(),
      messageStore,
      threadStore,
    }),
  );
}

describe('AgentRouter routing preview', () => {
  it('reports the same current-mention and previous-user-mention priority as send routing', async () => {
    const { ThreadStore } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');
    const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
    const threadStore = new ThreadStore();
    const messageStore = new MessageStore();
    const thread = threadStore.create('owner', 'preview priority');
    threadStore.updatePreferredCats(thread.id, ['gemini']);
    threadStore.addParticipants(thread.id, ['codex']);
    threadStore.updateParticipantActivity(thread.id, 'codex', true);
    messageStore.append({
      threadId: thread.id,
      userId: 'owner',
      from: { kind: 'user', userId: 'owner' },
      content: '@opus 上一条明确找你',
      mentions: ['opus'],
      timestamp: Date.now(),
    });
    const router = await createRouter(threadStore, messageStore);

    const carried = await router.previewTargets('继续刚才的内容', { threadId: thread.id });
    assert.deepEqual(carried.targetCats, ['opus']);
    assert.deepEqual(carried.reason, { kind: 'previous_user_mentions' });

    const explicit = await router.previewTargets('@gemini 这条改请你看', { threadId: thread.id });
    assert.deepEqual(explicit.targetCats, ['gemini']);
    assert.deepEqual(explicit.reason, { kind: 'current_message_mentions' });
    assert.equal(
      threadStore.getParticipants(thread.id).includes('gemini'),
      false,
      'read-only preview must not persist the explicit mention',
    );
    const admitted = await router.resolveTargetsAndIntent('@gemini 这条改请你看', thread.id, { persist: true });
    assert.deepEqual(admitted.targetCats, explicit.targetCats, 'preview and send must share the target resolver');
    assert.equal(
      threadStore.getParticipants(thread.id).includes('gemini'),
      true,
      'only send admission persists mention',
    );
  });

  it('distinguishes recent replier, preferred cat and prospective new-thread preference without writes', async () => {
    const { ThreadStore } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');
    const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
    const threadStore = new ThreadStore();
    const messageStore = new MessageStore();
    const router = await createRouter(threadStore, messageStore);

    const active = threadStore.create('owner', 'has reply');
    threadStore.updatePreferredCats(active.id, ['gemini']);
    threadStore.addParticipants(active.id, ['codex']);
    threadStore.updateParticipantActivity(active.id, 'codex', true);
    const recent = await router.previewTargets('没有新的 at', { threadId: active.id });
    assert.deepEqual(recent.targetCats, ['codex']);
    assert.deepEqual(recent.reason, { kind: 'recent_replier' });

    const quiet = threadStore.create('owner', 'no replies');
    threadStore.updatePreferredCats(quiet.id, ['gemini']);
    const preferred = await router.previewTargets('第一条消息', { threadId: quiet.id });
    assert.deepEqual(preferred.targetCats, ['gemini']);
    assert.deepEqual(preferred.reason, { kind: 'preferred_cat' });

    const prospectiveId = 'routing-preview:new-thread';
    const prospective = await router.previewTargets('还没创建对话', {
      threadId: prospectiveId,
      prospectivePreferredCats: ['opus'],
    });
    assert.deepEqual(prospective.targetCats, ['opus']);
    assert.deepEqual(prospective.reason, { kind: 'preferred_cat' });
    assert.equal(threadStore.get(prospectiveId), null, 'preview must not create a thread');
    assert.deepEqual(threadStore.getParticipants(prospectiveId), [], 'preview must not persist participants');
  });
});

describe('POST /api/routing/preview', () => {
  async function setup() {
    const { routingPreviewRoutes } = await import('../dist/routes/routing-preview.js');
    const { ThreadStore } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');
    const threadStore = new ThreadStore();
    const owned = threadStore.create('owner', 'owned');
    const calls = [];
    const router = {
      async previewTargets(content, options) {
        calls.push({ content, options });
        return { targetCats: ['codex'], reason: { kind: 'recent_replier' } };
      },
    };
    const app = Fastify();
    await app.register(routingPreviewRoutes, { threadStore, router });
    return { app, calls, owned };
  }

  it('previews an owned thread without mutating routing state', async () => {
    const { app, calls, owned } = await setup();
    const response = await app.inject({
      method: 'POST',
      url: '/api/routing/preview',
      headers: { 'x-cat-cafe-user': 'owner' },
      payload: { scope: 'thread', threadId: owned.id, content: 'draft @codex' },
    });

    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(response.json(), { targetCats: ['codex'], reason: { kind: 'recent_replier' } });
    assert.deepEqual(calls, [{ content: 'draft @codex', options: { threadId: owned.id } }]);
  });

  it('uses prospective preferred cats for a new conversation and rejects foreign threads', async () => {
    const { app, calls, owned } = await setup();
    const prospective = await app.inject({
      method: 'POST',
      url: '/api/routing/preview',
      headers: { 'x-cat-cafe-user': 'owner' },
      payload: { scope: 'new-thread', content: 'draft', preferredCats: ['gemini'] },
    });
    assert.equal(prospective.statusCode, 200, prospective.body);
    assert.deepEqual(calls.at(-1), {
      content: 'draft',
      options: { threadId: 'routing-preview:new-thread', prospectivePreferredCats: ['gemini'] },
    });

    const forbidden = await app.inject({
      method: 'POST',
      url: '/api/routing/preview',
      headers: { 'x-cat-cafe-user': 'someone-else' },
      payload: { scope: 'thread', threadId: owned.id, content: 'draft' },
    });
    assert.equal(forbidden.statusCode, 403, forbidden.body);
    assert.equal(calls.length, 1, 'foreign preview must not call the router');
  });

  it('rejects ambiguous scope and oversized content', async () => {
    const { app } = await setup();
    const ambiguous = await app.inject({
      method: 'POST',
      url: '/api/routing/preview',
      headers: { 'x-cat-cafe-user': 'owner' },
      payload: {
        scope: 'new-thread',
        threadId: 'not-allowed',
        preferredCats: ['codex'],
        content: 'draft',
      },
    });
    assert.equal(ambiguous.statusCode, 400, ambiguous.body);

    const oversized = await app.inject({
      method: 'POST',
      url: '/api/routing/preview',
      headers: { 'x-cat-cafe-user': 'owner' },
      payload: { scope: 'new-thread', preferredCats: [], content: 'x'.repeat(50_001) },
    });
    assert.equal(oversized.statusCode, 400, oversized.body);
  });
});
