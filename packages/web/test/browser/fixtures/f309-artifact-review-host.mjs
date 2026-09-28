import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { catRegistry } from '@cat-cafe/shared';
import { build } from 'vite';
import { InvocationRegistry } from '../../../../api/src/domains/cats/services/agents/invocation/InvocationRegistry.ts';
import { aggregateThreadArtifacts } from '../../../../api/src/domains/cats/services/agents/routing/thread-artifacts-aggregator.ts';
import { registerArtifactReviewRoutes } from '../../../../api/src/routes/artifact-review-routes.ts';
import { registerCallbackArtifactReviewRoutes } from '../../../../api/src/routes/callback-artifact-review-routes.ts';
import { registerCallbackAuthHook } from '../../../../api/src/routes/callback-auth-prehandler.ts';
import { registerCallbackTaskRoutes } from '../../../../api/src/routes/callback-task-routes.ts';
import { registerEntrustedWorkReadRoutes } from '../../../../api/src/routes/entrusted-work-read-routes.ts';
import { createLiveReviewFixture } from '../../../../api/test/helpers/artifact-review-live-fixture.ts';

const WEB_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const apiRequire = createRequire(path.resolve(WEB_ROOT, '../api/package.json'));
const Fastify = apiRequire('fastify'),
  cors = apiRequire('@fastify/cors');
const { Server: SocketServer } = apiRequire('socket.io');
const webRequire = createRequire(path.join(WEB_ROOT, 'package.json'));
const tailwind = webRequire('tailwindcss'),
  tailwindConfig = webRequire(path.join(WEB_ROOT, 'tailwind.config.js'));

export async function startReviewHost(root, mediaType, { port = 0, clientRevision } = {}) {
  assert.ok(Number.isInteger(port) && port >= 0 && port <= 65535);
  if (clientRevision !== undefined) assert.match(clientRevision, /^[a-f0-9]{40}$/);
  const revisionAttribute = clientRevision ? ` data-cat-cafe-build-revision="${clientRevision}"` : '';
  let sockets;
  const emitToUser = (userId, event, data) => sockets?.to(`user:${userId}`).emit(event, data);
  const f = await createLiveReviewFixture(root, mediaType, emitToUser);
  let bundle = '',
    css = '';
  const frontend = createServer(async (req, res) => {
    if (req.url === '/host.js') {
      res.setHeader('content-type', 'text/javascript');
      res.end(bundle);
      return;
    }
    if (req.url === '/host.css') {
      res.setHeader('content-type', 'text/css');
      res.end(css);
      return;
    }
    if (req.url?.startsWith('/avatars/')) {
      try {
        const relative = req.url.split('?')[0];
        assert.match(relative, /^\/avatars\/[A-Za-z0-9_.-]+$/);
        res.setHeader(
          'content-type',
          relative.endsWith('.svg') ? 'image/svg+xml' : relative.endsWith('.jpg') ? 'image/jpeg' : 'image/png',
        );
        res.end(await readFile(path.join(WEB_ROOT, 'public', relative)));
      } catch {
        res.statusCode = 404;
        res.end();
      }
      return;
    }
    res.setHeader('content-type', 'text/html');
    res.end(
      `<!doctype html><html lang="zh-CN"${revisionAttribute}><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/host.css"><style>body{margin:0}</style><div id="root"></div><script>window.__F309_FIXTURE__=${JSON.stringify({ threadId: f.thread.id })}</script><script type="module" src="/host.js"></script></html>`,
    );
  });
  await new Promise((resolve, reject) => {
    frontend.once('error', reject);
    frontend.listen(port, '127.0.0.1', resolve);
  });
  const origin = `http://127.0.0.1:${frontend.address().port}`;
  const app = Fastify();
  // The fixture's HTTP session is operator; use the same authenticated test principal for real Socket.IO transport.
  sockets = new SocketServer(app.server, { cors: { origin, credentials: true } });
  sockets.on('connection', (socket) => {
    void socket.join('user:operator');
  });
  app.decorateRequest('sessionUserId', null);
  app.addHook('onRequest', async (request) => {
    request.sessionUserId = 'operator';
  });
  await app.register(cors, { origin, credentials: true });
  app.get('/api/session', async () => ({ userId: 'operator' }));
  app.post('/api/session', async () => ({ userId: 'operator' }));
  app.get('/api/config', async () => ({
    config: { coCreator: { name: 'You', aliases: [], mentionPatterns: ['@co-creator'], avatar: '/avatars/owner.jpg' } },
  }));
  app.get('/api/cats', async () => ({
    cats: catRegistry.getAllIds().map((id) => ({ ...catRegistry.getOrThrow(id).config, id })),
  }));
  app.get('/api/config/cat-order', async () => ({ catOrder: ['codex-astra'] }));
  const artifacts = () =>
    aggregateThreadArtifacts({ messages: f.messages.getByThread(f.thread.id), prTasks: [], fileLedger: [] });
  app.get('/api/artifacts', async () => ({
    artifacts: artifacts().map((artifact) => ({ ...artifact, threadId: f.thread.id, threadTitle: f.thread.title })),
  }));
  app.get(`/api/threads/${f.thread.id}/artifacts`, async () => ({ artifacts: artifacts() }));
  app.get('/uploads/:name', async (request, reply) => {
    const { name } = request.params;
    if (!/^review-(?:input|response)\.(png|mp4)$/.test(name)) return reply.code(404).send();
    return reply.type(name.endsWith('.png') ? 'image/png' : 'video/mp4').send(await readFile(path.join(root, name)));
  });
  const registry = new InvocationRegistry();
  const credentials = await registry.create('operator', 'codex-astra', f.thread.id);
  await app.register(async (scope) => {
    registerCallbackAuthHook(scope, registry);
    registerCallbackTaskRoutes(scope, {
      taskStore: f.tasks,
      messageStore: f.messages,
      threadStore: f.threads,
      socketManager: { emitToUser, broadcastAgentMessage() {}, broadcastToRoom() {} },
    });
  });
  await app.register(async (scope) => registerArtifactReviewRoutes(scope, f));
  await registerCallbackArtifactReviewRoutes(app, { ...f, threads: f.threads, registry });
  await app.register(async (scope) =>
    registerEntrustedWorkReadRoutes(scope, { service: f.ownerReads, callbackRegistry: registry }),
  );
  const apiOrigin = await app.listen({ port: 0, host: '127.0.0.1' });
  const result = await build({
    root: WEB_ROOT,
    configFile: false,
    logLevel: 'silent',
    esbuild: { jsx: 'automatic' },
    css: {
      postcss: { plugins: [tailwind({ ...tailwindConfig, content: [path.join(WEB_ROOT, 'src/**/*.{ts,tsx}')] })] },
    },
    resolve: { alias: { '@': path.join(WEB_ROOT, 'src') } },
    define: { 'process.env.NEXT_PUBLIC_API_URL': JSON.stringify(apiOrigin) },
    build: {
      write: false,
      minify: false,
      rollupOptions: {
        input: path.join(WEB_ROOT, 'test/browser/fixtures/f309-artifact-review-workbench.tsx'),
        output: { format: 'es', inlineDynamicImports: true },
      },
    },
  }).catch(async (error) => {
    await close();
    throw error;
  });
  const outputs = Array.isArray(result) ? result.flatMap((item) => item.output) : result.output;
  bundle = outputs.find((item) => item.type === 'chunk' && item.isEntry).code;
  css = outputs
    .filter((item) => item.type === 'asset' && item.fileName.endsWith('.css'))
    .map((item) => item.source)
    .join('\n');
  async function callback(operation, body) {
    const response = await fetch(`${apiOrigin}/api/callbacks/${operation}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-invocation-id': credentials.invocationId,
        'x-callback-token': credentials.callbackToken,
      },
      body: JSON.stringify(body),
    });
    const value = await response.json();
    assert.equal(response.status, 200, JSON.stringify(value));
    return value;
  }
  async function close() {
    await f.dispatch.close();
    await new Promise((resolve) => sockets.close(resolve));
    await app.close();
    f.store.close();
    frontend.closeAllConnections();
    await new Promise((resolve) => frontend.close(resolve));
  }
  return {
    ...f,
    app,
    origin,
    apiOrigin,
    emitToUser,
    catCallback: (operation, body) => callback(`artifact-review/${operation}`, body),
    taskCallback: callback,
    close,
  };
}
