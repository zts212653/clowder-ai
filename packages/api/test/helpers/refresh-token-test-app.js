/**
 * F174 Phase C — shared test harness for refresh-token route tests.
 *
 * Cloud Codex P1 (PR #1368, c5927046): the original
 * callback-refresh-token.test.js exceeded the 350-line hard limit.
 * Tests are now split into auth / cooldown / stale files; this helper
 * keeps the boilerplate (registry + dependencies + Fastify app) DRY.
 */

import Fastify from 'fastify';
import './setup-cat-registry.js';

export async function createTestContext() {
  const { InvocationRegistry } = await import(
    '../../dist/domains/cats/services/agents/invocation/InvocationRegistry.js'
  );
  const { MessageStore } = await import('../../dist/domains/cats/services/stores/ports/MessageStore.js');
  const { ThreadStore } = await import('../../dist/domains/cats/services/stores/ports/ThreadStore.js');

  const registry = new InvocationRegistry();
  const messageStore = new MessageStore();
  const threadStore = new ThreadStore();
  const socketManager = {
    broadcastAgentMessage() {},
    broadcastToRoom() {},
    emitToUser() {},
  };
  const evidenceStore = {
    search: async () => [],
    health: async () => true,
    initialize: async () => {},
    upsert: async () => {},
    deleteByAnchor: async () => {},
    getByAnchor: async () => null,
  };
  const reflectionService = { reflect: async () => '' };
  const markerQueue = {
    submit: async (m) => ({ id: 'mk-1', createdAt: new Date().toISOString(), ...m }),
    list: async () => [],
    transition: async () => {},
  };

  async function createApp() {
    const { callbacksRoutes } = await import('../../dist/routes/callbacks.js');
    const app = Fastify();
    await app.register(callbacksRoutes, {
      registry,
      messageStore,
      socketManager,
      threadStore,
      evidenceStore,
      reflectionService,
      markerQueue,
    });
    return app;
  }

  return { registry, createApp };
}
