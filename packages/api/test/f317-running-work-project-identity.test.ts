import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import Fastify from 'fastify';
import type { InvocationRecord } from '../src/domains/cats/services/agents/invocation/InvocationRegistry.js';
import { type ActiveExecutionRouteDeps, registerActiveExecutionRoutes } from '../src/routes/active-execution-routes.js';
import { registerCompanionWorkReadRoutes } from '../src/routes/companion-work-read.js';

test('registered F295 and F317 share the persistent identity of a disposable runtime checkout', async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'f317-project-identity-')));
  const runtime = join(root, 'runtime');
  const workspace = join(root, 'workspace');
  await Promise.all([mkdir(runtime), mkdir(workspace)]);
  const prior = {
    runtime: process.env.CAT_CAFE_RUNTIME_ROOT,
    workspace: process.env.CAT_CAFE_WORKSPACE_ROOT,
  };
  process.env.CAT_CAFE_RUNTIME_ROOT = runtime;
  process.env.CAT_CAFE_WORKSPACE_ROOT = workspace;
  const app = Fastify();
  t.after(async () => {
    await app.close();
    for (const [key, value] of [
      ['CAT_CAFE_RUNTIME_ROOT', prior.runtime],
      ['CAT_CAFE_WORKSPACE_ROOT', prior.workspace],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  });
  app.addHook('preHandler', async (request) => {
    if (request.url.startsWith('/api/callbacks/companion/') && request.headers['x-test-principal'] === 'owner')
      request.callbackAuth = { userId: 'owner', threadId: 'home', catId: 'codex61-sol' } as unknown as InvocationRecord;
  });
  const thread = {
    id: 'work-one',
    projectPath: workspace,
    title: 'same work',
    createdBy: 'owner',
    participants: ['codex61-sol'],
  };
  const store = {
    get: async (id: string) => (id === thread.id ? thread : null),
    listByProject: async (user: string, path: string) => (user === 'owner' && path === workspace ? [thread] : []),
  } as unknown as ActiveExecutionRouteDeps['threadStore'];
  registerActiveExecutionRoutes(app, {
    threadStore: store,
    invocationTracker: { getUserId: () => 'owner', getExecutionId: () => 'private-execution' },
    resolveLiveExecutions: async () => [
      {
        catId: 'codex61-sol',
        startedAt: 10,
        executionId: 'private-execution',
        invocationId: 'private-child',
        ownerUserId: 'owner',
        controlSource: 'tracker',
      },
    ],
    cancelExactLiveInvocation: () => ({ cancelled: false }),
  });
  registerCompanionWorkReadRoutes(app, runtime);
  const upstream = await app.inject({
    url: `/api/executions/active?projectPath=${encodeURIComponent(runtime)}`,
    headers: { 'x-cat-cafe-user': 'owner' },
  });
  assert.equal(upstream.statusCode, 200, upstream.body);
  assert.equal(upstream.json().projectPath, workspace);
  const consumer = await app.inject({
    url: '/api/callbacks/companion/running-work',
    headers: { 'x-test-principal': 'owner' },
  });
  assert.equal(consumer.statusCode, 200, consumer.body);
  assert.equal(consumer.json().projectPath, workspace);
  assert.deepEqual(
    [consumer.json().executionCount, consumer.json().workGroupCount, consumer.json().workingThreadCount],
    [1, 1, 1],
  );
  assert.doesNotMatch(consumer.body, /private-execution|cancelability|executionId/);
});

for (const source of ['foreign-project', 'missing-source']) {
  test(`running work still rejects ${source} without inventing zero counts`, async (t) => {
    const app = Fastify();
    t.after(() => app.close());
    app.addHook('preHandler', async (request) => {
      request.callbackAuth = { userId: 'owner', threadId: 'home', catId: 'codex61-sol' } as unknown as InvocationRecord;
    });
    app.get('/api/executions/active', async () =>
      source === 'foreign-project' ? { projectPath: '/another/project', executions: [] } : {},
    );
    registerCompanionWorkReadRoutes(app, '/original/project');
    const response = await app.inject('/api/callbacks/companion/running-work');
    assert.equal(response.statusCode, 503);
    assert.equal(response.json().status, 'unavailable');
    assert.equal('workingThreadCount' in response.json(), false);
  });
}
