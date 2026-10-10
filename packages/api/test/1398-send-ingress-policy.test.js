import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import Fastify from 'fastify';
import './helpers/setup-cat-registry.js';
import { saveMessageDispositionPreference } from '../dist/config/user-preferences-store.js';
import { InvocationQueue } from '../dist/domains/cats/services/agents/invocation/InvocationQueue.js';
import { InvocationRegistry } from '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js';
import { InvocationTracker } from '../dist/domains/cats/services/agents/invocation/InvocationTracker.js';
import { PersistedQueueDelivery } from '../dist/domains/cats/services/agents/invocation/PersistedQueueDelivery.js';
import { MessageStore } from '../dist/domains/cats/services/stores/ports/MessageStore.js';
import { ThreadStore } from '../dist/domains/cats/services/stores/ports/ThreadStore.js';
import { ConnectorRouter } from '../dist/infrastructure/connectors/ConnectorRouter.js';
import { MemoryConnectorThreadBindingStore } from '../dist/infrastructure/connectors/ConnectorThreadBindingStore.js';
import { InboundMessageDedup } from '../dist/infrastructure/connectors/InboundMessageDedup.js';
import { deliverConnectorMessage } from '../dist/infrastructure/email/deliver-connector-message.js';
import { createDeliverFn } from '../dist/infrastructure/scheduler/delivery.js';
import { callbacksRoutes } from '../dist/routes/callbacks.js';
import { messagesRoutes } from '../dist/routes/messages.js';

// Actual ingress implementations, shared Message/Queue stores; transport and drain are isolated fixtures.
for (const disposition of ['next_work', 'continue_current']) {
  test(`current HTTP/callback/IM/mail/notification/scheduler entrances share ${disposition} admission`, async (t) => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'f117-ingress-policy-'));
    saveMessageDispositionPreference(projectRoot, { scope: 'global', disposition });
    const owner = 'ingress-owner';
    const threads = new ThreadStore();
    const thread = threads.create(owner, 'Shared ingress');
    const messages = new MessageStore();
    const tracker = new InvocationTracker();
    tracker.start(thread.id, 'opus', owner, ['opus'], 'exact-ingress-parent');
    const capability = {
      provider: 'anthropic',
      carrier: 'claude_agent_sdk',
      activeInvocationGuidance: 'supported',
      deliverySemantics: 'exact_active_turn',
    };
    const notifications = [];
    const queue = new InvocationQueue(undefined, {
      projectRoot,
      invocationTracker: tracker,
      resolveCarrierCapability: () => capability,
      resolveTargets: async (targets) => (targets.length ? [...targets] : ['opus']),
      onAdmitted: ({ entries, message }) => {
        assert.ok(messages.getById(message.id), 'no wake before durable source');
        notifications.push(entries);
      },
    });
    const delivery = new PersistedQueueDelivery({
      messages,
      queue,
      progress: async () => 'owned_deferred_busy',
    });
    const registry = new InvocationRegistry();
    const router = {
      resolveTargetsAndIntent: async () => ({ targetCats: ['opus'], intent: { intent: 'execute' } }),
      resolveExplicitTargets: async (cats) => cats,
      resolveConversationTargetsAtAdmission: async (cats) => (cats.length ? cats : ['opus']),
      freshnessCarrierCapability: () => capability,
    };
    const socketManager = { broadcastToRoom() {}, emitToUser() {}, broadcastAgentMessage() {} };
    const app = Fastify();
    t.after(() => app.close());
    await app.register(messagesRoutes, {
      registry,
      messageStore: messages,
      threadStore: threads,
      invocationQueue: queue,
      invocationTracker: tracker,
      router,
      socketManager,
    });
    await app.register(callbacksRoutes, {
      registry,
      messageStore: messages,
      threadStore: threads,
      invocationQueue: queue,
      router,
      socketManager,
      invocationRecordStore: {},
      queueProcessor: { registerCallerDispatchInitialTargets() {} },
    });
    const user = await app.inject({
      method: 'POST',
      url: '/api/messages',
      headers: { 'x-cat-cafe-user': owner },
      payload: { threadId: thread.id, content: 'user payload', idempotencyKey: randomUUID() },
    });
    assert.equal(user.statusCode, 202, user.body);
    const auth = await registry.create(owner, 'codex', thread.id);
    const callback = await app.inject({
      method: 'POST',
      url: '/api/callbacks/post-message',
      headers: { 'x-invocation-id': auth.invocationId, 'x-callback-token': auth.callbackToken },
      payload: { threadId: thread.id, targetCats: ['opus'], content: 'agent payload', clientMessageId: 'agent-policy' },
    });
    assert.equal(callback.statusCode, 200, callback.body);
    assert.equal(callback.json().status, 'ok', callback.body);
    const bindings = new MemoryConnectorThreadBindingStore();
    bindings.bind('feishu', 'policy-chat', thread.id, owner);
    const im = new ConnectorRouter({
      bindingStore: bindings,
      dedup: new InboundMessageDedup(),
      messageStore: messages,
      persistedQueueDelivery: delivery,
      threadStore: threads,
      defaultUserId: owner,
      defaultCatId: 'codex',
      socketManager,
      log: { debug() {}, info() {}, warn() {}, error() {} },
    });
    assert.equal((await im.route('feishu', 'policy-chat', 'IM payload', 'im-policy')).kind, 'routed');
    const mail = await deliverConnectorMessage(
      { delivery },
      {
        threadId: thread.id,
        userId: owner,
        content: 'mail payload',
        idempotencyKey: 'mail-policy',
        source: { connector: 'email', label: 'Mail' },
      },
    );
    assert.equal(mail.admitted, true);
    await delivery.deliver({
      ownerUserId: owner,
      threadId: thread.id,
      targetCatId: 'opus',
      content: 'notification payload',
      idempotencyKey: 'notification-policy',
      source: { connector: 'github-wait', label: 'GitHub Wait' },
      sourceCategory: 'ci',
    });
    await createDeliverFn({ messageStore: messages, socketManager, persistedQueueDelivery: delivery })({
      userId: owner,
      threadId: thread.id,
      targetCatId: 'opus',
      content: 'scheduled payload',
      idempotencyKey: 'scheduler-policy',
      sourceCategory: 'scheduled',
    });
    const entries = queue.list(thread.id, owner);
    assert.equal(entries.length, 6);
    assert.equal(notifications.length, 6, 'each admission notifies the common owner, not a producer loop');
    for (const entry of entries) {
      assert.deepEqual(entry.targets, ['opus'], 'IM/mail no-target fallback uses common send, not defaultCatId');
      assert.equal(entry.delivery.authorIntentByTarget.opus.requested, disposition, entry.payload.content);
      if (disposition === 'continue_current')
        assert.equal(entry.delivery.authorIntentByTarget.opus.boundParentInvocationId, 'exact-ingress-parent');
    }
    saveMessageDispositionPreference(projectRoot, {
      scope: 'global',
      disposition: disposition === 'next_work' ? 'continue_current' : 'next_work',
    });
    await deliverConnectorMessage(
      { delivery },
      {
        threadId: thread.id,
        userId: owner,
        content: 'mail payload',
        idempotencyKey: 'mail-policy',
        source: { connector: 'email', label: 'Mail' },
      },
    );
    assert.equal(queue.list(thread.id, owner).length, 6);
    const replay = queue.list(thread.id, owner).find((entry) => entry.payload.content === 'mail payload');
    assert.equal(replay.delivery.authorIntentByTarget.opus.requested, disposition);
  });
}
