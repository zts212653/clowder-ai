import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ThreadStore } from '../../../api/dist/domains/cats/services/stores/ports/ThreadStore.js';
import cors from '../../../api/node_modules/@fastify/cors/index.js';
import Fastify from '../../../api/node_modules/fastify/fastify.js';

export async function startSearchGroupApi(port = 0) {
  const owner = 'f277-search-browser-owner';
  process.env.DEFAULT_OWNER_USER_ID = owner;
  const { configThreadAttentionRoutes } = await import('../../../api/dist/routes/config-thread-attention.js');
  const root = await mkdtemp(path.join(tmpdir(), 'cat-cafe-f277-browser-'));
  const store = new ThreadStore();
  const titles = [
    'F311 产品讨论',
    '[F311/Phase 1] 实现与可见性',
    'F311 review 记录',
    '其他项目的搭档',
    'F3110 不应匹配',
    'F311 系统对话',
  ];
  const threads = titles.map((title) => store.create(owner, title, '/workspace/cat-cafe'));
  store.updatePin(threads[0].id, true);
  store.updatePin(threads[4].id, true);
  store.updateSystemKind(threads[5].id, 'eval_domain');
  const app = Fastify();
  let failNext = false;
  await app.register(cors, { origin: true, credentials: true });
  app.decorateRequest('sessionUserId', null);
  // Authenticated owner fixture: synthetic data only, bound to loopback. Production auth remains unchanged.
  app.addHook('onRequest', async (request, reply) => {
    request.sessionUserId = owner;
    if (failNext && request.method === 'POST' && request.url === '/api/config/thread-attention/groups') {
      failNext = false;
      return reply.code(500).send({ error: 'injected browser failure' });
    }
  });
  await app.register(configThreadAttentionRoutes, { projectRoot: root, threadStore: store });
  app.get('/api/threads', async () => ({
    threads: store.list(owner).map((thread) => ({ ...thread, unreadCount: 0 })),
  }));
  app.get('/api/session', async () => ({ userId: owner }));
  app.get('/api/cats', async () => ({ cats: [] }));
  app.get('/api/labels', async () => []);
  app.get('/api/governance/health', async () => ({ projects: [] }));
  app.get('/api/projects/cwd', async () => ({ path: '/workspace/cat-cafe' }));
  app.get('/api/config/bubble-defaults', async () => ({}));
  app.post('/__test/fail-next', async () => {
    failNext = true;
    return { ok: true };
  });
  app.get('/__test/threads', async () => threads);
  app.setNotFoundHandler((_request, reply) => reply.send({}));
  await app.ready();
  const seed = await app.inject({
    method: 'POST',
    url: '/api/config/thread-attention/groups',
    payload: { action: 'create', threadIds: [threads[2].id, threads[3].id], name: '已有工作组' },
  });
  if (seed.statusCode !== 200) throw new Error(seed.payload);
  const url = await app.listen({ port, host: '127.0.0.1' });
  return {
    app,
    url,
    threads,
    store,
    async close() {
      await app.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const fixture = await startSearchGroupApi(Number(process.argv[2] ?? '3182'));
  process.stdout.write(`F277 isolated API ready: ${fixture.url}\n`);
  for (const signal of ['SIGINT', 'SIGTERM'])
    process.once(signal, async () => {
      await fixture.close();
      process.exit(0);
    });
}
