import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import Fastify from 'fastify';
import { catRegistry } from '@cat-cafe/shared';
import { invokeSingleCat } from '../dist/domains/cats/services/agents/invocation/invoke-single-cat.js';
import { SessionChainStore } from '../dist/domains/cats/services/stores/ports/SessionChainStore.js';
import { sessionChainRoutes } from '../dist/routes/session-chain.js';
import { isolateAccountAuthEnvironment } from './helpers/account-auth-environment.js';
import { routingJourneyDeps } from './helpers/routing-journey-deps.js';

test('a pre-upgrade imported Claude session can resume and re-import without replacing its identity', async (t) => {
  t.after(isolateAccountAuthEnvironment());
  const directory = resolve('artifacts/pr1790-legacy-import');
  mkdirSync(directory, { recursive: true });
  const root = mkdtempSync(join(directory, 'case-'));
  const original = catRegistry.getAllConfigs();
  catRegistry.reset();
  Object.entries(original).forEach(([id, config]) => catRegistry.register(id, id === 'opus'
    ? { ...config, configurationSource: 'native_tool', accountRef: undefined, mcpSupport: false }
    : config));
  t.after(() => { catRegistry.reset(); Object.entries(original).forEach(([id, config]) => catRegistry.register(id, config)); });
  const userId = 'default-user';
  const threadId = 'audit-import-thread';
  const catId = 'opus';
  const cliSessionId = randomUUID();
  const store = new SessionChainStore();
  const legacy = store.create({ catId, threadId, userId, cliSessionId });
  store.update(legacy.id, { externalImport: { cliSessionId, clientId: 'anthropic', projectPath: root, importedAt: 1 }, workingDirectory: root });
  const calls = [];
  const service = {
    implementationSnapshot: () => ({ key: 'audit:claude', generation: 'stable', compatibilityRevision: 'stable' }),
    async *invoke(prompt, options) {
      calls.push({ resume: options.cliSessionId });
      yield { type: 'session_init', catId, sessionId: options.cliSessionId ?? cliSessionId, timestamp: Date.now() };
      yield { type: 'done', catId, timestamp: Date.now() };
    },
  };
  const threadStore = {
    get: async () => ({ id: threadId, createdBy: userId, projectPath: root }),
    setSessionImport: async () => ({ id: threadId, createdBy: userId, projectPath: root }),
  };
  const deps = routingJourneyDeps(undefined, undefined, service).deps.invocationDeps;
  Object.assign(deps, { sessionChainStore: store, threadStore });
  deps.sessionManager.get = async () => cliSessionId;
  const messages = await Array.fromAsync(invokeSingleCat(deps, {
    catId, service, userId, threadId, prompt: 'AUDIT_TASK', systemPrompt: 'AUDIT_ROLE', isLastCat: true,
    ownerAuthProvenance: 'strict',
  }));
  const boundary = {
    v: 1, clientId: 'anthropic', carrier: 'cli', implementationKey: 'audit:claude',
    implementationGeneration: 'stable', accountRef: null,
    workspaceRoot: process.platform === 'win32' ? root.toLowerCase() : root,
    projectRoot: process.platform === 'win32' ? root.toLowerCase() : root,
  };
  const app = Fastify();
  t.after(() => app.close());
  await app.register(sessionChainRoutes, {
    sessionChainStore: store, threadStore,
    inspectLocalSession: async () => ({ sessionId: cliSessionId, clientId: 'anthropic', projectPath: root, firstPrompt: 'old imported task' }),
    resolveImportExecutionBoundary: async () => boundary,
    resolveSessionSealLiveness: async () => ({ catIds: [], complete: true }),
  });
  const reimport = await app.inject({ method: 'PATCH', url: `/api/threads/${threadId}/sessions/${catId}/bind`,
    headers: { 'x-cat-cafe-user': userId }, payload: { cliSessionId, externalImport: true } });
  const result = { platform: process.platform, fakeProvider: true, providerCalls: calls,
    invocationErrors: messages.filter((message) => message.type === 'error').map((message) => message.error),
    reimportStatus: reimport.statusCode, reimportBody: reimport.json(),
    logicalIdentityPreserved: store.getActive(catId, threadId, userId)?.id === legacy.id,
    nativeIdentityPreserved: store.get(legacy.id).cliSessionId === cliSessionId };
  writeFileSync(join(root, 'result.json'), JSON.stringify(result, null, 2));
  t.diagnostic(JSON.stringify(result));
  assert.equal(calls.length, 1, 'the existing imported session must receive the task');
  assert.equal(reimport.statusCode, 200, reimport.body);
  assert.equal(calls[0].resume, cliSessionId);
  assert.equal(result.logicalIdentityPreserved, true);
  assert.equal(result.nativeIdentityPreserved, true);
});
