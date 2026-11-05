/**
 * Reply ownership (infrastructure/api-server.ts): once a reply has started
 * sending, the handler's return value must not make Fastify send again.
 *
 * Runtime crash 2026-11-04: an unauthenticated GET /api/eval-hub/summary sent its
 * 401, returned undefined, and Fastify re-sent while async onSend hooks were still
 * pending. The second writeHead threw ERR_HTTP_HEADERS_SENT and the process exited.
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const settle = () => new Promise((resolve) => setTimeout(resolve, 25));
const tick = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function server() {
  const { createApiServer } = await import('../dist/infrastructure/api-server.js');
  return createApiServer({ logger: false });
}

/** Same shape as installApprovalDecisionReceiptHooks for a request without a subject. */
function countingRootOnSend(app) {
  const counter = { sends: 0 };
  app.addHook('onSend', async (_request, _reply, payload) => {
    counter.sends++;
    return payload;
  });
  return counter;
}

/** An onSend that takes real time (like a Redis write), so the reply stays in flight. */
function slowRootOnSend(app) {
  const counter = { sends: 0 };
  app.addHook('onSend', async (_request, _reply, payload) => {
    counter.sends++;
    await tick(10);
    return payload;
  });
  return counter;
}

const rejectingRegistry = { verify: async () => ({ ok: false, reason: 'unknown_invocation' }) };

test('an early send-then-return reply in a callback auth scope is sent once', async (t) => {
  const { registerCallbackAuthHook } = await import('../dist/routes/callback-auth-prehandler.js');
  const app = await server();
  t.after(() => app.close());
  const counter = countingRootOnSend(app);
  await app.register(async (scope) => {
    registerCallbackAuthHook(scope, rejectingRegistry);
    scope.get('/test/early-send', async (_request, reply) => {
      reply.status(401).send({ error: 'Session required' });
      return;
    });
  });

  const response = await app.inject({ method: 'GET', url: '/test/early-send' });
  await settle();
  assert.equal(response.statusCode, 401);
  assert.deepEqual(response.json(), { error: 'Session required' });
  assert.equal(counter.sends, 1, 'the 401 must go through onSend once, not twice');
});

test('unauthenticated eval hub summary answers 401 once', async (t) => {
  const { evalHubRoutes } = await import('../dist/routes/eval-hub.js');
  const app = await server();
  t.after(() => app.close());
  const counter = countingRootOnSend(app);
  await app.register(evalHubRoutes, {
    harnessFeedbackRoot: '/nonexistent-eval-hub-root',
    callbackRegistry: rejectingRegistry,
  });

  const response = await app.inject({ method: 'GET', url: '/api/eval-hub/summary' });
  await settle();
  assert.equal(response.statusCode, 401);
  assert.deepEqual(response.json(), { error: 'Session required' });
  assert.equal(counter.sends, 1, 'the 401 must go through onSend once, not twice');
});

/** A watcher-ticket request whose completion write takes real time, like Redis. */
async function watcherApp(t, completeWatcherToolCallback, route) {
  const { registerCallbackAuthHook } = await import('../dist/routes/callback-auth-prehandler.js');
  const app = await server();
  t.after(() => app.close());
  await app.register(async (scope) => {
    registerCallbackAuthHook(scope, { ...rejectingRegistry, completeWatcherToolCallback });
    scope.addHook('preHandler', async (request) => {
      request.watcherToolTicket = { invocationId: 'inv-watch', callId: 'call-0' };
    });
    scope.post('/test/watcher-tool', route);
  });
  return app;
}

test('a watcher tool rejection that returns early records one completion and one response', async (t) => {
  const completions = [];
  const app = await watcherApp(
    t,
    async (invocationId, callId, response) => {
      await tick(10);
      completions.push({ invocationId, callId, ...response });
    },
    async (_request, reply) => {
      reply.status(400).send({ error: 'invalid watcher input' });
      return;
    },
  );

  const response = await app.inject({ method: 'POST', url: '/test/watcher-tool' });
  await tick(40);
  assert.equal(response.statusCode, 400);
  assert.deepEqual(response.json(), { error: 'invalid watcher input' });
  assert.deepEqual(completions, [
    { invocationId: 'inv-watch', callId: 'call-0', statusCode: 400, body: '{"error":"invalid watcher input"}' },
  ]);
});

test('a watcher reply fails when its completion rejects without a reason', async (t) => {
  const app = await watcherApp(
    t,
    () => Promise.reject(),
    async (_request, reply) => reply.status(201).send({ ok: true }),
  );

  const response = await app.inject({ method: 'POST', url: '/test/watcher-tool' });
  assert.equal(response.statusCode, 500, 'an unrecorded watcher reply must not look successful');
});

test('an early object reply behind an async preSerialization hook is sent once', async (t) => {
  const app = await server();
  t.after(() => app.close());
  let serializations = 0;
  app.addHook('preSerialization', async (_request, _reply, payload) => {
    serializations++;
    await tick(5);
    return payload;
  });
  app.get('/test/early-object', async (_request, reply) => {
    reply.status(403).send({ error: 'forbidden' });
    return;
  });

  const response = await app.inject({ method: 'GET', url: '/test/early-object' });
  await settle();
  assert.equal(response.statusCode, 403);
  assert.deepEqual(response.json(), { error: 'forbidden' });
  assert.equal(serializations, 1);
});

test('an early text reply behind an async onSend hook is sent once', async (t) => {
  const app = await server();
  t.after(() => app.close());
  const counter = countingRootOnSend(app);
  app.addHook('onSend', async (_request, _reply, payload) => {
    await tick(5);
    return payload;
  });
  app.get('/test/early-text', async (_request, reply) => {
    reply.status(404).send('not found');
    return;
  });

  const response = await app.inject({ method: 'GET', url: '/test/early-text' });
  await settle();
  assert.equal(response.statusCode, 404);
  assert.equal(response.body, 'not found');
  assert.equal(counter.sends, 1);
});

test('an early error reply behind an async onSend hook is sent once', async (t) => {
  const app = await server();
  t.after(() => app.close());
  const counter = countingRootOnSend(app);
  app.addHook('onSend', async (_request, _reply, payload) => {
    await tick(5);
    return payload;
  });
  app.get('/test/early-error', async (_request, reply) => {
    reply.status(409).send(new Error('conflict'));
    return;
  });

  const response = await app.inject({ method: 'GET', url: '/test/early-error' });
  await settle();
  assert.equal(response.statusCode, 409);
  assert.equal(response.json().message, 'conflict');
  assert.equal(counter.sends, 1);
});

test('a handler that returns nothing without sending still gets its empty reply', async (t) => {
  const app = await server();
  t.after(() => app.close());
  countingRootOnSend(app);
  app.delete('/test/no-content', async (_request, reply) => {
    reply.code(204);
  });

  const response = await app.inject({ method: 'DELETE', url: '/test/no-content' });
  assert.equal(response.statusCode, 204);
  assert.equal(response.body, '');
});

test('eval hub summary with an incomplete callback credential answers 401 once', async (t) => {
  const { evalHubRoutes } = await import('../dist/routes/eval-hub.js');
  const app = await server();
  t.after(() => app.close());
  const counter = slowRootOnSend(app);
  await app.register(evalHubRoutes, {
    harnessFeedbackRoot: '/nonexistent-eval-hub-root',
    callbackRegistry: rejectingRegistry,
  });

  const response = await app.inject({
    method: 'GET',
    url: '/api/eval-hub/summary',
    headers: { 'x-invocation-id': 'inv-only' },
  });
  await settle();
  assert.equal(response.statusCode, 401);
  assert.equal(response.json().reason, 'missing_creds');
  assert.equal(counter.sends, 1, 'the preHandler 401 must not be followed by the route sending again');
});

test('a callback auth rejection stops later hooks and the route handler', async (t) => {
  const { registerCallbackAuthHook } = await import('../dist/routes/callback-auth-prehandler.js');
  const app = await server();
  t.after(() => app.close());
  const counter = slowRootOnSend(app);
  const reached = { laterHook: 0, handler: 0 };
  await app.register(async (scope) => {
    registerCallbackAuthHook(scope, rejectingRegistry);
    scope.addHook('preHandler', async () => {
      reached.laterHook++;
    });
    scope.post('/test/tool', async () => {
      reached.handler++;
      return { executed: true };
    });
  });

  const response = await app.inject({ method: 'POST', url: '/test/tool', headers: { 'x-invocation-id': 'inv-only' } });
  await settle();
  assert.equal(response.statusCode, 401);
  assert.deepEqual(reached, { laterHook: 0, handler: 0 });
  assert.equal(counter.sends, 1);
});

test('a route-level async hook that sends without returning the reply stops later hooks and the handler', async (t) => {
  const app = await server();
  t.after(() => app.close());
  const counter = slowRootOnSend(app);
  const reached = { laterHook: 0, handler: 0 };
  app.post(
    '/test/route-hook',
    {
      preValidation: async (_request, reply) => {
        reply.code(413).send({ error: 'too_large' });
      },
      preHandler: async () => {
        reached.laterHook++;
      },
    },
    async () => {
      reached.handler++;
      return { ok: true };
    },
  );

  const response = await app.inject({ method: 'POST', url: '/test/route-hook' });
  await settle();
  assert.equal(response.statusCode, 413);
  assert.deepEqual(reached, { laterHook: 0, handler: 0 });
  assert.equal(counter.sends, 1);
});

test('a promise-returning plain function hook that sends stops later hooks and the handler', async (t) => {
  const app = await server();
  t.after(() => app.close());
  const counter = slowRootOnSend(app);
  const reached = { laterHook: 0, handler: 0 };
  const guard = async (reply) => {
    reply.code(403).send({ error: 'forbidden' });
  };
  app.addHook('preHandler', (_request, reply) => guard(reply));
  app.addHook('preHandler', async (_request, reply) => {
    reached.laterHook++;
    reply.code(401).send({ error: 'second denial' });
  });
  app.get('/test/plain-hook', async () => {
    reached.handler++;
    return { ok: true };
  });

  const response = await app.inject({ method: 'GET', url: '/test/plain-hook' });
  await settle();
  assert.equal(response.statusCode, 403);
  assert.deepEqual(response.json(), { error: 'forbidden' });
  assert.deepEqual(reached, { laterHook: 0, handler: 0 });
  assert.equal(counter.sends, 1);
});

test('a callback-style hook still controls the lifecycle through done', async (t) => {
  const app = await server();
  t.after(() => app.close());
  app.addHook('preHandler', (request, _reply, done) => {
    setTimeout(() => {
      request.passedCallbackHook = true;
      done();
    }, 5);
  });
  app.get('/test/callback-hook', async (request) => ({ passed: request.passedCallbackHook === true }));

  const response = await app.inject({ method: 'GET', url: '/test/callback-hook' });
  assert.deepEqual(response.json(), { passed: true });
});

test('Fastify still rejects an async lifecycle hook that also declares done', async (t) => {
  const app = await server();
  t.after(() => app.close());
  await assert.rejects(
    async () => {
      await app.register(async (scope) => {
        scope.addHook('preHandler', async (_request, _reply, _done) => {});
      });
    },
    { code: 'FST_ERR_HOOK_INVALID_ASYNC_HANDLER' },
  );
});

function sourceFiles() {
  const srcRoot = fileURLToPath(new URL('../src/', import.meta.url));
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith('.ts'))
        out.push({ path: relative(srcRoot, path), code: readFileSync(path, 'utf8') });
    }
  };
  walk(srcRoot);
  return out;
}

test('API source creates its Fastify instance only through createApiServer', () => {
  const offenders = sourceFiles()
    .filter(({ path }) => path !== join('infrastructure', 'api-server.ts'))
    .filter(({ code }) => /^\s*import\s+Fastify\b/m.test(code) || /\bFastify\s*\(\s*\{/.test(code))
    .map(({ path }) => path);
  assert.deepEqual(offenders, [], 'a bare Fastify() skips the reply ownership hooks; use createApiServer');
});

test('a synchronous scoped error handler still answers once behind an async onSend', async (t) => {
  const app = await server();
  t.after(() => app.close());
  const counter = slowRootOnSend(app);
  await app.register(async (scope) => {
    scope.setErrorHandler((error, _request, reply) => {
      reply.code(422).send({ error: error.message });
    });
    scope.get('/test/scoped-error', async () => {
      throw new Error('bad input');
    });
  });

  const response = await app.inject({ method: 'GET', url: '/test/scoped-error' });
  await settle();
  assert.equal(response.statusCode, 422);
  assert.deepEqual(response.json(), { error: 'bad input' });
  assert.equal(counter.sends, 1);
});
