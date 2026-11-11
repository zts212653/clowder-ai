import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { catRegistry } from '@cat-cafe/shared';
import Fastify from 'fastify';
import { captureImportedSessionBoundary } from '../dist/domains/cats/services/agents/invocation/import-execution-boundary.js';
import { invokeSingleCat } from '../dist/domains/cats/services/agents/invocation/invoke-single-cat.js';
import { SessionSealer } from '../dist/domains/cats/services/session/SessionSealer.js';
import { SessionChainStore } from '../dist/domains/cats/services/stores/ports/SessionChainStore.js';
import { DeclaredRuntimeContributions } from '../dist/domains/plugin/declared/declared-runtime-contributions.js';
import { pluginWebhookForwardingRoutes } from '../dist/routes/plugin/plugin-webhook-forwarding-routes.js';
import { sessionChainRoutes } from '../dist/routes/session-chain.js';
import { isolateAccountAuthEnvironment } from './helpers/account-auth-environment.js';
import { routingJourneyDeps } from './helpers/routing-journey-deps.js';

function fixture(t) {
  t.after(isolateAccountAuthEnvironment());
  const original = catRegistry.getAllConfigs();
  const catId = 'astra-review';
  const config = {
    ...original.codex,
    id: catId,
    mcpSupport: false,
    configurationSource: 'native_tool',
    accountRef: undefined,
  };
  catRegistry.register(catId, config);
  t.after(() => {
    catRegistry.reset();
    for (const [id, value] of Object.entries(original)) catRegistry.register(id, value);
  });
  const store = new SessionChainStore();
  const calls = [];
  let resume;
  const makeService = () => ({
    async *invoke(prompt, options) {
      calls.push({ prompt, resume: options.cliSessionId, hostSessionId: options.hostSessionId });
      yield {
        type: 'session_init',
        catId,
        sessionId: options.cliSessionId ?? `native-${calls.length}`,
        timestamp: Date.now(),
      };
      yield { type: 'done', catId, timestamp: Date.now() };
    },
  });
  let service = makeService();
  const { deps: routing } = routingJourneyDeps(undefined, undefined, service);
  const deps = routing.invocationDeps;
  deps.sessionChainStore = store;
  deps.sessionSealer = new SessionSealer(store);
  const projectPath = resolve(process.cwd());
  deps.threadStore = {
    get: () => ({ id: 'thread', projectPath, createdBy: 'owner' }),
    list: () => [{ id: 'thread', projectPath, createdBy: 'owner' }],
    setSessionImport: async () => {},
  };
  deps.sessionManager.get = async () => resume;
  deps.sessionManager.store = async (_user, _cat, _thread, id) => {
    resume = id;
  };
  deps.sessionManager.delete = async () => {
    resume = undefined;
  };
  const invoke = () =>
    Array.fromAsync(
      invokeSingleCat(deps, {
        catId,
        service,
        userId: 'owner',
        threadId: 'thread',
        prompt: 'CURRENT_TASK',
        systemPrompt: 'ROLE',
        isLastCat: true,
        ownerAuthProvenance: 'strict',
        rebuildPromptAfterSessionSeal: async () => 'AUTHORIZED_CONTEXT_SUMMARY\nCURRENT_TASK',
      }),
    );
  return {
    catId,
    store,
    calls,
    deps,
    invoke,
    projectPath,
    importBoundary: (input) => captureImportedSessionBoundary(deps, { ...input, service }),
    reconstructSameService: () => {
      service = makeService();
    },
  };
}

test('control: retaining the service resumes the existing native session', async (t) => {
  const f = fixture(t);
  await f.invoke();
  await f.invoke();
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[1].resume, 'native-1');
});

test('unchanged service reconstruction must preserve the native conversation', async (t) => {
  const f = fixture(t);
  await f.invoke();
  const before = structuredClone(f.store.getActive(f.catId, 'thread', 'owner'));
  f.reconstructSameService();
  const events = await f.invoke();
  assert.equal(f.calls.length, 2, JSON.stringify(events.filter((e) => e.type === 'error')));
  const old = f.store.get(before.id);
  console.log(
    'REBUILD_EVIDENCE',
    JSON.stringify({
      previousStatus: old.status,
      sealReason: old.sealReason,
      secondResume: f.calls[1].resume ?? null,
      chainLength: f.store.getChain(f.catId, 'thread', 'owner').length,
    }),
  );
  assert.equal(f.calls[1].resume, 'native-1');
});

test('successful public native import must allow the next task to reach the provider', async (t) => {
  const f = fixture(t);
  const priorOwner = process.env.DEFAULT_OWNER_USER_ID;
  process.env.DEFAULT_OWNER_USER_ID = 'owner';
  t.after(() => {
    if (priorOwner === undefined) delete process.env.DEFAULT_OWNER_USER_ID;
    else process.env.DEFAULT_OWNER_USER_ID = priorOwner;
  });
  const app = Fastify();
  t.after(() => app.close());
  app.addHook('onRequest', async (request) => {
    request.sessionUserId = 'owner';
  });
  const nativeId = '01901234-1234-7123-8123-123456789abc';
  await app.register(sessionChainRoutes, {
    sessionChainStore: f.store,
    threadStore: f.deps.threadStore,
    sessionSealer: f.deps.sessionSealer,
    resolveImportExecutionBoundary: f.importBoundary,
    inspectLocalSession: async () => ({
      sessionId: nativeId,
      clientId: 'openai',
      projectPath: f.projectPath,
      firstPrompt: 'Existing conversation',
      lastActivityAt: Date.now(),
    }),
  });
  const response = await app.inject({
    method: 'PATCH',
    url: `/api/threads/thread/sessions/${f.catId}/bind`,
    payload: { cliSessionId: nativeId, externalImport: true },
  });
  assert.equal(response.statusCode, 200, response.body);
  const events = await f.invoke();
  console.log(
    'IMPORT_EVIDENCE',
    JSON.stringify({
      importStatus: response.statusCode,
      errors: events.filter((e) => e.type === 'error').map((e) => e.error),
      providerCalls: f.calls.length,
    }),
  );
  assert.equal(f.calls.length, 1, 'Imported session must be usable after successful inspection and bind');
  assert.equal(f.calls[0].resume, nativeId);
  assert.equal(f.store.getActive(f.catId, 'thread', 'owner').hostExecutionBoundary.clientId, 'openai');
});

test('webhook dispatch must preserve the declared action params', async (t) => {
  let received;
  const admission = {
    instance: { pluginInstanceId: 'test' },
    packageRecord: {
      pluginId: 'dev.review',
      manifest: {
        contributions: [
          {
            type: 'webhook',
            id: 'page',
            path: 'panel',
            methods: ['GET'],
            action: { method: 'panel', params: { pane: 'diagnostics' } },
          },
        ],
      },
    },
  };
  const contributions = new DeclaredRuntimeContributions({
    packages: {
      resolveInstalledPackage: async () => {
        throw new Error('no executable package needed');
      },
    },
    configuration: { readConfig: async () => undefined, readSecret: async () => undefined },
  });
  await contributions.activate(admission, async (_id, _method, input) => {
    received = input;
    return { status: 200, headers: { 'content-type': 'text/html' }, body: '<p>test</p>' };
  });
  t.after(() => contributions.deactivateAll());
  const app = Fastify();
  t.after(() => app.close());
  app.addHook('onRequest', async (request) => {
    request.sessionUserId = 'owner';
  });
  await app.register(pluginWebhookForwardingRoutes, { webhooks: contributions });
  const response = await app.inject({
    method: 'GET',
    url: '/api/plugins/dev.review/panel',
    headers: { origin: 'http://localhost:5173' },
  });
  assert.equal(response.statusCode, 200, response.body);
  console.log('PARAMS_EVIDENCE', JSON.stringify(received));
  assert.equal(received.pane, 'diagnostics');
});

for (const failure of ['unavailable', 'capture-failed', 'different-client']) {
  test(`formal import fails before binding when execution verification is ${failure}`, async (t) => {
    const f = fixture(t);
    const app = Fastify();
    t.after(() => app.close());
    app.addHook('onRequest', async (request) => {
      request.sessionUserId = 'owner';
    });
    const nativeId = '01901234-1234-7123-8123-123456789abc';
    await app.register(sessionChainRoutes, {
      sessionChainStore: f.store,
      threadStore: f.deps.threadStore,
      inspectLocalSession: async () => ({
        sessionId: nativeId,
        clientId: 'openai',
        projectPath: f.projectPath,
        firstPrompt: 'Existing conversation',
        lastActivityAt: Date.now(),
      }),
      resolveImportExecutionBoundary:
        failure === 'unavailable'
          ? undefined
          : async (input) => {
              if (failure === 'capture-failed') throw new Error('selected client could not be verified');
              return { ...(await f.importBoundary(input)), clientId: 'google' };
            },
    });
    const response = await app.inject({
      method: 'PATCH',
      url: `/api/threads/thread/sessions/${f.catId}/bind`,
      payload: { cliSessionId: nativeId, externalImport: true },
    });
    assert.equal(response.statusCode, failure === 'unavailable' ? 503 : 409);
    assert.equal(f.store.getByCliSessionId(nativeId), null);
    assert.equal(f.calls.length, 0);
  });
}
