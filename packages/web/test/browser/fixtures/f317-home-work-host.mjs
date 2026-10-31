import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { catRegistry } from '@cat-cafe/shared';
import { build } from 'vite';
import { resolveCompanionWorkPublication } from '../../../../api/src/domains/concierge/live/host/home/companion-work-publication.ts';
import { HomeHubDelivery } from '../../../../api/src/domains/concierge/live/host/home/home-hub-delivery.ts';
import { createHomeSocketEmitter } from '../../../../api/src/domains/concierge/live/host/home/home-socket-emitter.ts';
import { CompanionWorkOverview } from '../../../../api/src/domains/concierge/live/work/companion-work-overview.ts';
import { WorkspaceContentSourceService } from '../../../../api/src/domains/workspace/workspace-content-source.ts';
import { f317HomeOwnerRoutes } from '../../../../api/src/routes/f317-home-actions.ts';
import { registerPublishedContentRoutes } from '../../../../api/src/routes/published-content-routes.ts';
import { registerWorkspaceContentReviewRoutes } from '../../../../api/src/routes/workspace-content-review-routes.ts';
import { createLiveReviewFixture } from '../../../../api/test/helpers/artifact-review-live-fixture.ts';

const webRoot = fileURLToPath(new URL('../../..', import.meta.url));
const apiRequire = createRequire(path.resolve(webRoot, '../api/package.json'));
const Fastify = apiRequire('fastify'),
  cors = apiRequire('@fastify/cors'),
  { Server } = apiRequire('socket.io');
const webRequire = createRequire(path.join(webRoot, 'package.json'));

/** Synthetic private session issuer and card trigger; every owner, delivery, resolve and renderer is shipped code. */
export async function startHomeWorkHost(root) {
  const workspace = new WorkspaceContentSourceService({
    ownerUserId: 'operator',
    resolveWorktreeRoot: async () => ({ root, canonicalWorktreeId: 'work' }),
  });
  const f = await createLiveReviewFixture(root, 'image/png', undefined, workspace);
  assert.ok(f.ledgers, 'the publication renderer requires the original workspace review owner');
  const app = Fastify();
  let bundle = '',
    css = '',
    selectedRef;
  const observations = [],
    outcomes = [];
  const frontend = createServer((_req, res) => {
    if (_req.url === '/host.js') {
      res.setHeader('content-type', 'text/javascript');
      return res.end(bundle);
    }
    if (_req.url === '/host.css') {
      res.setHeader('content-type', 'text/css');
      return res.end(css);
    }
    res.setHeader('content-type', 'text/html');
    res.end(
      `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><link rel="stylesheet" href="/host.css"><div id="root"></div><script>window.__F317_WORK__=${JSON.stringify({ threadId: f.thread.id })}</script><script type="module" src="/host.js"></script></html>`,
    );
  });
  await new Promise((resolve) => frontend.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${frontend.address().port}`;
  const sockets = new Server(app.server, { cors: { origin, credentials: true } });
  sockets.on('connection', (socket) => void socket.join('user:operator'));
  app.decorateRequest('sessionUserId', null);
  app.addHook('onRequest', async (request) => {
    request.sessionUserId = 'operator';
  });
  await app.register(cors, { origin, credentials: true });
  app.get('/api/session', async () => ({ userId: 'operator' }));
  app.get('/api/cats', async () => ({
    cats: catRegistry.getAllIds().map((id) => ({ ...catRegistry.getOrThrow(id).config, id })),
  }));
  app.get('/api/config', async () => ({ config: { coCreator: { name: 'You', aliases: [], mentionPatterns: [] } } }));
  app.get('/api/config/cat-order', async () => ({ catOrder: ['codex-astra'] }));
  const homeSockets = createHomeSocketEmitter({
    getIO: () => sockets,
    broadcastToRoom: (rooms, event, data) => sockets.to(rooms).emit(event, data),
    broadcastToRoomWithAck: async (rooms, event, data, timeout) => {
      try {
        const result = await sockets.to(rooms).timeout(timeout).emitWithAck(event, data);
        observations.push({ at: Date.now(), event, result });
        return result;
      } catch {
        return [];
      }
    },
  });
  const hub = new HomeHubDelivery({
    messages: f.messages,
    threads: f.threads,
    isCurrent: async () => true,
    emitter: homeSockets.emitter,
  });
  const options = {
    ownerUserId: 'operator',
    projectPath: root,
    tasks: f.tasks,
    messages: f.messages,
    threads: f.threads,
    artifactLineage: f.globalArtifactWorkLineage,
    assertCurrent: async () => {},
  };
  const work = new CompanionWorkOverview({
    ...options,
    open: (destination) =>
      hub.openWork('operator', () => resolveCompanionWorkPublication(options, destination), options.assertCurrent),
  });
  await app.register(f317HomeOwnerRoutes, {
    ownerUserId: 'operator',
    service: { hub },
    isOwnerConnection: homeSockets.ownsConnection,
  });
  registerPublishedContentRoutes(app, { media: f.media });
  registerWorkspaceContentReviewRoutes(app, { reviews: f.ledgers, namespace: 'publication' });
  app.post('/fixture/work/open', async () => {
    assert.ok(selectedRef, 'select an owner-issued original card before the test');
    const delivery = await work.open(selectedRef);
    const outcome = { delivery, at: Date.now() };
    outcomes.push(outcome);
    return outcome;
  });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const apiOrigin = `http://127.0.0.1:${app.server.address().port}`;
  async function close() {
    hub.close();
    work.reset();
    await f.dispatch.close();
    await new Promise((resolve) => sockets.close(resolve));
    await app.close();
    f.store.close();
    frontend.closeAllConnections();
    await new Promise((resolve) => frontend.close(resolve));
  }
  try {
    const built = await build({
      root: webRoot,
      configFile: false,
      logLevel: 'silent',
      esbuild: { jsx: 'automatic' },
      resolve: { alias: { '@': path.join(webRoot, 'src') } },
      define: { 'process.env.NEXT_PUBLIC_API_URL': JSON.stringify(apiOrigin) },
      css: {
        postcss: {
          plugins: [
            webRequire('tailwindcss')({
              ...webRequire(path.join(webRoot, 'tailwind.config.js')),
              content: [path.join(webRoot, 'src/**/*.{ts,tsx}')],
            }),
          ],
        },
      },
      build: {
        write: false,
        minify: false,
        rollupOptions: {
          input: path.join(webRoot, 'test/browser/fixtures/f317-home-work-display.tsx'),
          output: { format: 'es', inlineDynamicImports: true },
        },
      },
    });
    const outputs = Array.isArray(built) ? built.flatMap((item) => item.output) : built.output;
    bundle = outputs.find((item) => item.type === 'chunk' && item.isEntry).code;
    css = outputs
      .filter((item) => item.type === 'asset' && item.fileName.endsWith('.css'))
      .map((item) => item.source)
      .join('\n');
  } catch (error) {
    await close();
    throw error;
  }
  return {
    ...f,
    app,
    hub,
    work,
    origin,
    apiOrigin,
    observations,
    outcomes,
    close,
    select: async (version) => {
      const row = (await work.read()).recentDeliveries.find((row) => row.artifact?.version === String(version));
      assert.ok(row, 'exact owner version missing');
      selectedRef = row.entryRef;
      return row;
    },
  };
}
