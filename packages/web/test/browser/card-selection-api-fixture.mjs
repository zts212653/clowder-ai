import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const requireApi = createRequire(new URL('../../../api/package.json', import.meta.url));
const Fastify = requireApi('fastify');
const apiRoot = new URL('../../../api/', import.meta.url);
const source = (relative) => import(new URL(`src/${relative}`, apiRoot));

/** Actual stores, Queue admission, Bundle hydration and exports; only provider execution is absent. */
export async function createCardSelectionApiFixture() {
  const [
    { MessageStore },
    { ThreadStore },
    { InvocationRegistry },
    { InvocationQueue },
    { messagesRoutes },
    { messageBundleRoutes },
    { exportRoutes },
    { threadExportRoutes },
    { catRegistry },
    { loadCatConfig, toAllCatConfigs },
  ] = await Promise.all([
    source('domains/cats/services/stores/ports/MessageStore.ts'),
    source('domains/cats/services/stores/ports/ThreadStore.ts'),
    source('domains/cats/services/agents/invocation/InvocationRegistry.ts'),
    source('domains/cats/services/agents/invocation/InvocationQueue.ts'),
    source('routes/messages.ts'),
    source('routes/message-bundles.ts'),
    source('routes/export.ts'),
    source('routes/thread-export.ts'),
    import('@cat-cafe/shared'),
    source('config/cat-config-loader.ts'),
  ]);
  const configs = toAllCatConfigs(
    loadCatConfig(fileURLToPath(new URL('../../../../cat-template.json', import.meta.url))),
  );
  for (const [id, config] of Object.entries(configs)) if (!catRegistry.has(id)) catRegistry.register(id, config);
  const userId = 'card-selection-test-user';
  const messageStore = new MessageStore();
  const threadStore = new ThreadStore();
  const sourceThread = threadStore.create(userId, '转发内容检查', '/fixture/card-selection');
  const targetThread = threadStore.create(userId, '接收测试对话', '/fixture/card-selection');
  const rich = messageStore.append({
    threadId: sourceThread.id,
    userId,
    from: { kind: 'agent', catId: 'codex' },
    content: '两件都弄好了：',
    mentions: [],
    timestamp: 1792797600000,
    origin: 'callback',
    extra: {
      isExplicitPost: true,
      rich: {
        v: 1,
        blocks: [
          { id: 'result-card', kind: 'card', v: 1, title: '审批卡统一结果行', bodyMarkdown: '#5963 · 已合入' },
          { id: 'quota-card', kind: 'card', v: 1, title: '额度表 · 本周', bodyMarkdown: '3 个号' },
        ],
      },
    },
  });
  const plain = messageStore.append({
    threadId: sourceThread.id,
    userId,
    from: { kind: 'agent', catId: 'opus' },
    content: '对过稿了，可以给 You 看。',
    mentions: [],
    timestamp: 1792797840000,
    origin: 'callback',
    extra: { isExplicitPost: true },
  });
  const queue = new InvocationQueue();
  const app = Fastify();
  const sockets = new (requireApi('socket.io').Server)(app.server, { cors: { origin: true, credentials: true } });
  app.addHook('preClose', async () => {
    sockets.disconnectSockets(true);
    sockets.engine.close();
  });
  await app.register(requireApi('@fastify/cors'), { origin: true, credentials: true });
  // Deliberately never accepts or reuses an owner's browser session.
  app.addHook('onRequest', async (request) => {
    request.headers['x-cat-cafe-user'] = userId;
    request.sessionUserId = userId;
  });
  await app.register(messagesRoutes, {
    messageStore,
    threadStore,
    invocationQueue: queue,
    registry: new InvocationRegistry(),
    router: {
      resolveExplicitTargets: async (cats) => cats,
      resolveConversationTargetsAtAdmission: async (cats) => cats,
    },
    socketManager: { broadcastAgentMessage() {}, broadcastToRoom() {}, emitToUser() {} },
  });
  await app.register(messageBundleRoutes, { messageStore, threadStore });
  await app.register(exportRoutes, { messageStore, threadStore });
  await app.register(threadExportRoutes, { messageStore, threadStore });
  const browserMessage = (message) => ({
    ...message,
    catId: message.from.kind === 'agent' ? message.from.catId : undefined,
    type: message.from.kind === 'agent' ? 'assistant' : 'user',
  });
  const messages = [rich, plain].map(browserMessage);
  app.get('/api/card-selection-fixture', async () => ({ source: sourceThread, target: targetThread, messages }));
  app.get('/api/health', async () => ({ status: 'ok' }));
  app.get('/api/ready', async () => ({ status: 'ok' }));
  app.get('/api/session', async () => ({ ok: true, userId }));
  app.get('/api/cats', async () => ({
    cats: ['codex', 'opus'].map((id) => ({ ...configs[id], id, roster: { available: true } })),
  }));
  app.get('/api/threads', async () => ({ threads: [sourceThread, targetThread] }));
  app.get('/api/threads/:id', async (request) => threadStore.get(request.params.id));
  app.get('/api/threads/:id/messages', async (request) => ({
    messages: messageStore.getByThread(request.params.id, 100).map(browserMessage),
    hasMore: false,
  }));
  app.setNotFoundHandler(async (_request, reply) =>
    reply.code(404).send({ error: 'Not part of this isolated fixture' }),
  );
  await app.ready();
  return { app, messageStore, threadStore, sourceThread, targetThread, rich, plain, userId, queue };
}
