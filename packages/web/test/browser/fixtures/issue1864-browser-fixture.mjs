import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const load = (file) => import(pathToFileURL(file).href);
export async function buildWorksFixture(web, out) {
  const reqWeb = createRequire(path.join(web, 'package.json'));
  const { build } = await load(reqWeb.resolve('vite'));
  const entry = await readFile(path.join(web, 'test/browser/fixtures/issue1864-visible.entry.tsx'), 'utf8');
  const fixture = (file) => path.join(web, 'test/browser/fixtures', file);
  const entryId = fixture('issue1864-proof-entry.tsx').replaceAll('\\', '/');
  const buildOrigin = 'https://issue1864-proof.test';
  const bundle = path.join(out, 'proof.js');
  const styles = path.join(out, 'proof.css');
  process.chdir(web);
  {
    const built = await build({
      root: web,
      configFile: false,
      logLevel: 'silent',
      esbuild: { jsx: 'automatic' },
      plugins: [
        {
          name: 'entry',
          resolveId: (id) => (id === 'issue1864-proof' ? entryId : undefined),
          load: (id) => (id === entryId ? entry : undefined),
        },
      ],
      resolve: {
        alias: [
          { find: 'next/navigation', replacement: fixture('f322-shell-navigation.ts') },
          { find: '@/hooks/useSocket', replacement: fixture('f322-chat-socket.ts') },
          { find: '@', replacement: path.join(web, 'src') },
        ],
      },
      define: { 'process.env.NEXT_PUBLIC_API_URL': JSON.stringify(buildOrigin) },
      build: {
        write: false,
        minify: false,
        rollupOptions: { input: 'issue1864-proof', output: { format: 'es', inlineDynamicImports: true } },
      },
    });
    await writeFile(bundle, built.output.find((item) => item.type === 'chunk' && item.isEntry).code);
    await writeFile(
      styles,
      built.output
        .filter((item) => item.type === 'asset' && item.fileName.endsWith('.css'))
        .map((item) => item.source)
        .join('\n'),
    );
  }
  const script = await readFile(bundle, 'utf8');
  const css = await readFile(styles, 'utf8');

  return { script, css };
}
export async function createWorksFixture(api, scenario, script, css) {
  const reqApi = createRequire(path.join(api, 'package.json'));
  const Fastify = reqApi('fastify');
  const { MessageStore } = await load(path.join(api, 'src/domains/cats/services/stores/ports/MessageStore.ts'));
  const { TaskStore } = await load(path.join(api, 'src/domains/cats/services/stores/ports/TaskStore.ts'));
  const { threadsRoutes } = await load(path.join(api, 'src/routes/threads.ts'));
  const buildOrigin = 'https://issue1864-proof.test';
  const control = { failNext: 0, holdNext: false, held: false, release: null };
  const owner = 'issue1864-owner',
    thread = 'issue1864-thread';
  const messages = new MessageStore(),
    tasks = new TaskStore();
  const total = scenario === 'sparse' ? 1100 : scenario === 'home-empty' || scenario === 'task-pr' ? 0 : 400;
  const epoch = Date.now() - 100000;
  const append = (i, work = true) =>
    messages.append({
      userId: owner,
      from: { kind: 'agent', catId: 'codex61-sol' },
      threadId: thread,
      timestamp: epoch + i,
      content: work ? '' : 'ordinary chat',
      mentions: [],
      ...(work
        ? {
            extra: {
              rich: {
                v: 1,
                blocks: [{ kind: 'file', v: 1, id: `file-${i}`, url: `/uploads/${i}.pdf`, fileName: `Proof-${i}.pdf` }],
              },
            },
          }
        : {}),
    });
  Array.from({ length: total }, (_, i) => append(i, scenario === 'sparse' ? i < 16 : i < 144 || i > 271));
  const routes = [];
  let origin;
  const identity = owner;
  const app = Fastify();
  let mutateTask;
  if (scenario === 'task-pr') {
    await load(path.join(api, 'test/helpers/setup-cat-registry.js'));
    const { InvocationRegistry } = await load(
      path.join(api, 'src/domains/cats/services/agents/invocation/InvocationRegistry.ts'),
    );
    const { EntrustedWorkLifecycleService } = await load(
      path.join(api, 'src/domains/growing/EntrustedWorkLifecycleService.ts'),
    );
    const { registerCallbackAuthHook } = await load(path.join(api, 'src/routes/callback-auth-prehandler.ts'));
    const { registerCallbackTaskRoutes } = await load(path.join(api, 'src/routes/callback-task-routes.ts'));
    const registry = new InvocationRegistry();
    const credentials = await registry.create(owner, 'codex', thread);
    const lifecycle = new EntrustedWorkLifecycleService(tasks);
    const admitted = await lifecycle.admitOrResume({
      task: {
        threadId: thread,
        title: 'Real Task publication',
        why: '',
        createdBy: 'user',
        userId: owner,
        ownerCatId: 'codex',
      },
      admission: {
        basis: 'explicit_entrustment',
        sourceRefs: ['message:fixture'],
        idempotencyKey: 'fixture-task-pr',
        intendedOutcome: 'Publish the accepted Task PR into Works',
      },
      closure: { condition: 'Fixture publication is visible', expectedSignal: 'works' },
    });
    if (admitted.result === 'needs_clarification') throw new Error(JSON.stringify(admitted));
    const taskId = admitted.ownerRef.slice('task:item:'.length);
    const events = [];
    registerCallbackAuthHook(app, registry);
    registerCallbackTaskRoutes(app, {
      taskStore: tasks,
      messageStore: messages,
      socketManager: {
        broadcastToRoom() {},
        emitToUser: (_user, event, data) => {
          if (event === 'entrusted_work_projection_invalidated') events.push(data);
        },
      },
    });
    mutateTask = async (change) => {
      const current = await tasks.get(taskId);
      events.length = 0;
      const response = await app.inject({
        method: 'POST',
        url: '/api/callbacks/update-entrusted-work',
        headers: { 'x-invocation-id': credentials.invocationId, 'x-callback-token': credentials.callbackToken },
        payload: { taskId, expectedRevision: current.entrustedWork.revision, ...change },
      });
      if (response.statusCode !== 200) throw new Error(response.body);
      return [...events];
    };
  }
  app.addHook('onRequest', async (request) => {
    request.headers['x-cat-cafe-user'] = identity;
    if (!request.url.startsWith('/api/artifacts')) return;
    const item = { id: request.id, url: request.url, started: true, completed: false, cancelled: false };
    routes.push(item);
    request.raw.on('aborted', () => {
      item.cancelled = true;
    });
  });
  app.addHook('onResponse', async (request, reply) => {
    const item = routes.find((item) => item.id === request.id);
    if (item) {
      item.completed = true;
      item.status = reply.statusCode;
    }
  });
  app.addHook('preHandler', async (request, reply) => {
    if (!request.url.startsWith('/api/artifacts')) return;
    if (control.failNext && request.url.includes('read=pages')) {
      const status = control.failNext;
      control.failNext = 0;
      return reply.code(status).send({ error: 'injected source failure' });
    }
    if (scenario === 'home-error' && request.url.includes('recent-works'))
      return reply.code(503).send({ error: 'injected recent failure' });
  });
  app.addHook('onSend', async (request, _reply, body) => {
    const item = routes.find((item) => item.id === request.id);
    if (item && typeof body === 'string') {
      const parsed = JSON.parse(body);
      Object.assign(item, {
        completed: true,
        count: parsed.artifacts?.length,
        complete: parsed.complete,
        cursor: parsed.nextCursor,
      });
    }
    return body;
  });
  await app.register(threadsRoutes, {
    threadStore: {
      list: async (user) => {
        if (control.holdNext) {
          control.holdNext = false;
          control.held = true;
          await new Promise((resolve) => {
            control.release = resolve;
          });
        }
        return user === owner
          ? [{ id: thread, title: 'Synthetic history', createdBy: owner, updatedAt: epoch + total }]
          : [];
      },
    },
    messageStore: messages,
    taskStore: tasks,
    artifactWorkLineage: { current: { resolve: async ({ artifacts }) => artifacts.map(() => undefined) } },
  });
  app.get('/', async (_req, reply) =>
    reply
      .type('text/html')
      .send(
        '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/proof.css"><div id="root"></div><script type="module" src="/proof.js"></script>',
      ),
  );
  app.get('/proof.js', async (_req, reply) =>
    reply.type('text/javascript').send(script.replaceAll(buildOrigin, origin)),
  );
  app.get('/proof.css', async (_req, reply) => reply.type('text/css').send(css));
  app.get('/api/session', async () => ({ userId: identity, csrfToken: 'fixture-csrf' }));
  app.get('/api/cats', async () => ({ cats: [] }));
  app.get('/api/config/cat-order', async () => ({ catOrder: [] }));
  origin = await app.listen({ host: '127.0.0.1', port: 0 });

  return { app, origin, routes, append, control, mutateTask };
}
