import Fastify from 'fastify';
import { MessageStore } from '../../dist/domains/cats/services/stores/ports/MessageStore.js';
import { ThreadStore } from '../../dist/domains/cats/services/stores/ports/ThreadStore.js';
import { MatterMemoryService } from '../../dist/domains/memory/matters/MatterMemoryService.js';
import { SqliteEvidenceStore } from '../../dist/domains/memory/SqliteEvidenceStore.js';
import { registerCallbackAuthHook } from '../../dist/routes/callback-auth-prehandler.js';
import { registerCallbackMemoryRoutes } from '../../dist/routes/callback-memory-routes.js';
import { registerCallbackMessageReadRoutes } from '../../dist/routes/callback-message-read-routes.js';
import { registerCallbackRememberRoutes } from '../../dist/routes/callback-remember-routes.js';
import { memoryCueInvocationReadRoutes } from '../../dist/routes/memory-cue-invocation-read.js';
import { memoryMatterRoutes } from '../../dist/routes/memory-matter-routes.js';

export async function matterCallbackFixture() {
  let app, evidenceStore, messageStore, threadStore, threadA, threadB, credentials, original, correction;
  evidenceStore = new SqliteEvidenceStore(':memory:');
  await evidenceStore.initialize().catch((error) => {
    throw new Error(error.message, { cause: error });
  });
  messageStore = new MessageStore();
  threadStore = new ThreadStore();
  threadA = threadStore.create('owner-a', 'Design discussion');
  threadB = threadStore.create('owner-a', 'Implementation');
  original = messageStore.append({
    from: { kind: 'user', userId: 'owner-a' },
    userId: 'owner-a',
    threadId: threadA.id,
    content: 'Use the existing navigation for the settings entry.',
    mentions: [],
    timestamp: 1_000,
  });
  correction = messageStore.append({
    from: { kind: 'user', userId: 'owner-a' },
    userId: 'owner-a',
    threadId: threadA.id,
    content: 'The settings entry now belongs in the existing workspace panel.',
    mentions: [],
    timestamp: 2_000,
  });
  credentials = new Map([
    ['call-a', { threadId: threadA.id, catId: 'codex-astra' }],
    ['call-b', { threadId: threadB.id, catId: 'codex61-sol' }],
  ]);
  app = Fastify();
  app.addHook('onRequest', async (request) => {
    if (['owner-a', 'owner-b'].includes(request.headers['x-test-owner-session'])) {
      request.sessionUserId = request.headers['x-test-owner-session'];
      request.sessionBindingId = 'owner-test-session';
      request.sessionCsrfToken = 'test-csrf';
    }
  });
  registerCallbackAuthHook(app, {
    async verify(invocationId, token) {
      const caller = credentials.get(invocationId);
      if (!caller || token !== `token-${invocationId}`) return { ok: false, reason: 'invalid_token' };
      return {
        ok: true,
        record: {
          ...caller,
          invocationId,
          callbackToken: token,
          userId: 'owner-a',
          ownerAuthProvenance: 'strict',
          clientMessageIds: new Set(),
          createdAt: 1,
          expiresAt: null,
          state: 'active',
        },
      };
    },
  });
  const matterMemoryService = new MatterMemoryService({
    db: evidenceStore.getDb(),
    messageStore,
    threadStore,
    runWrite: (operation) => evidenceStore.runExclusive(operation),
  });
  await app.register(memoryMatterRoutes, { provider: () => matterMemoryService });
  await app.register(memoryCueInvocationReadRoutes, {
    evidenceDb: evidenceStore.getDb(),
    matterMemoryService,
    threadStore,
    invocationRecordStore: {
      get: async (id) =>
        credentials.has(id)
          ? { id, userId: 'owner-a', threadId: credentials.get(id).threadId, targetCats: [credentials.get(id).catId] }
          : null,
    },
    turnExecutionStore: { get: async () => null },
  });
  await registerCallbackMemoryRoutes(app, {
    evidenceStore,
    messageStore,
    threadStore,
    matterRouteProvider: () => matterMemoryService,
    markerQueue: {
      submit: async () => {
        throw new Error('This journey must not write a marker summary');
      },
    },
    reflectionService: {
      reflect: async () => {
        throw new Error('This journey must not invoke a summarizer');
      },
    },
  });
  registerCallbackRememberRoutes(app, {
    registry: { isLatest: async () => true },
    messageStore,
    socketManager: { broadcastToRoom() {}, emitToUser() {} },
  });
  registerCallbackMessageReadRoutes(app, { messageStore, threadStore });
  await app.ready();
  return { app, evidenceStore, messageStore, threadStore, threadA, threadB, credentials, original, correction };
}
export const headers = (invocationId) => ({
  'x-invocation-id': invocationId,
  'x-callback-token': `token-${invocationId}`,
});
export const source = (message) => ({
  threadId: message.threadId,
  messageId: message.id,
  segment: 'body',
  start: 0,
  end: message.content.length,
  quote: message.content,
});
