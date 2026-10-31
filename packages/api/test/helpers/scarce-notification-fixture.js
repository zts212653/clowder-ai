import './setup-cat-registry.js';
import { loadDossierProfiles } from '@cat-cafe/shared/dossier';
import Fastify from 'fastify';
import { createRoutingDossierFixture } from './routing-dossier-fixture.js';

export async function createScarceNotificationFixture() {
  const dossier = createRoutingDossierFixture();
  let app;
  const { InvocationRegistry } = await import(
    '../../dist/domains/cats/services/agents/invocation/InvocationRegistry.js'
  );
  const { MessageStore } = await import('../../dist/domains/cats/services/stores/ports/MessageStore.js');
  const { ThreadStore } = await import('../../dist/domains/cats/services/stores/ports/ThreadStore.js');
  const { DeliveryCursorStore } = await import('../../dist/domains/cats/services/stores/ports/DeliveryCursorStore.js');
  const { InvocationQueue } = await import('../../dist/domains/cats/services/agents/invocation/InvocationQueue.js');
  const { AgentKeyRegistry } = await import('../../dist/domains/cats/services/agents/agent-key/AgentKeyRegistry.js');
  const registry = new InvocationRegistry();
  const messages = new MessageStore();
  const threads = new ThreadStore();
  const cursors = new DeliveryCursorStore();
  const records = [];
  const queue = new InvocationQueue(undefined, {
    onAdmitted: ({ entries }) => {
      if (entries.length) records.push({ targetCats: entries.flatMap((entry) => entry.targets) });
    },
  });
  const agentKeys = new AgentKeyRegistry();
  const source = await threads.create('user-1', 'Source');
  const target = await threads.create('user-1', 'Target');
  await threads.addParticipants(target.id, ['fable-5', 'codex']);
  const executions = [];
  async function setup({ queued = false, useDefaultReader = false } = {}) {
    const { callbacksRoutes } = await import('../../dist/routes/callbacks.js');
    app = Fastify();
    await app.register(callbacksRoutes, {
      registry,
      agentKeyRegistry: agentKeys,
      messageStore: messages,
      threadStore: threads,
      deliveryCursorStore: cursors,
      // Exercise the production parser with installation-owned synthetic policy.
      ...(useDefaultReader
        ? {}
        : {
            getEngagementPolicy: (catId) => loadDossierProfiles(dossier.root).get(catId)?.engagementPolicy,
          }),
      socketManager: { broadcastAgentMessage() {}, broadcastToRoom() {}, emitToUser() {} },
      router: {
        async *routeExecution(...args) {
          executions.push(args);
          yield* [];
        },
      },
      invocationRecordStore: {
        create(input) {
          records.push(input);
          return { outcome: 'created', invocationId: `inv-${records.length}` };
        },
        update() {},
        get() {
          return null;
        },
      },
      invocationQueue: queue,
      queueProcessor: { registerCallerDispatchInitialTargets() {}, async requestDrain() {} },
    });
    return registry.create('user-1', 'opus', source.id);
  }

  function post(auth, payload) {
    return app.inject({
      method: 'POST',
      url: '/api/callbacks/post-message',
      headers: { 'x-invocation-id': auth.invocationId, 'x-callback-token': auth.callbackToken },
      payload: { content: 'Published notification', targetCats: ['fable-5'], ...payload },
    });
  }

  return {
    registry,
    messages,
    threads,
    cursors,
    queue,
    agentKeys,
    source,
    target,
    records,
    executions,
    setup,
    post,
    dossierRoot: dossier.root,
    get app() {
      return app;
    },
    close: async () => {
      try {
        await app?.close();
      } finally {
        dossier.close();
      }
    },
  };
}
