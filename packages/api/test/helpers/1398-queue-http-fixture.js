import './setup-cat-registry.js';
import Fastify from 'fastify';
import { InvocationQueue } from '../../dist/domains/cats/services/agents/invocation/InvocationQueue.js';
import { InvocationRegistry } from '../../dist/domains/cats/services/agents/invocation/InvocationRegistry.js';
import { AgentRegistry } from '../../dist/domains/cats/services/agents/registry/AgentRegistry.js';
import { AgentRouter } from '../../dist/domains/cats/services/agents/routing/AgentRouter.js';
import { MessageStore } from '../../dist/domains/cats/services/stores/ports/MessageStore.js';
import { ThreadStore } from '../../dist/domains/cats/services/stores/ports/ThreadStore.js';
import { messagesRoutes } from '../../dist/routes/messages.js';
import { routingPreviewRoutes } from '../../dist/routes/routing-preview.js';

export async function queueHttpFixture(t, { messageStore } = {}) {
  const agents = new AgentRegistry();
  for (const catId of ['opus', 'codex', 'gemini']) {
    agents.register(catId, {
      async *invoke() {
        throw new Error('Admission must not invoke a provider');
      },
    });
  }
  const messages = messageStore ?? new MessageStore();
  const threads = new ThreadStore();
  const thread = threads.create('owner', 'real preview and admission');
  const registry = new InvocationRegistry();
  const router = new AgentRouter({ agentRegistry: agents, registry, messageStore: messages, threadStore: threads });
  const queue = new InvocationQueue(undefined, {
    resolveTargets: (targets, threadId, content, exact) => router.resolveSendTargets(targets, threadId, content, exact),
  });
  const app = Fastify();
  t.after(() => app.close());
  await app.register(routingPreviewRoutes, { threadStore: threads, router });
  await app.register(messagesRoutes, {
    registry,
    router,
    invocationQueue: queue,
    messageStore: messages,
    threadStore: threads,
    socketManager: { broadcastToRoom() {}, emitToUser() {}, broadcastAgentMessage() {} },
  });
  const reply = (catId, healthy = true) => {
    messages.append({
      from: { kind: 'agent', catId },
      userId: 'owner',
      threadId: thread.id,
      content: 'Existing reply without lifecycle metadata',
      mentions: [],
      timestamp: Date.now() - 1000,
    });
    threads.updateParticipantActivity(thread.id, catId, healthy);
  };
  return { app, agents, router, queue, messages, threads, thread, reply };
}
