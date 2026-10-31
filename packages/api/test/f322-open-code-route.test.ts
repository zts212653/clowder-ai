import assert from 'node:assert/strict';
import { test } from 'node:test';
import { catRegistry, createCatId } from '@cat-cafe/shared';
import Fastify from 'fastify';
import { loadCatConfig, toAllCatConfigs } from '../src/config/cat-config-loader.js';
import { hasOpenCodeSessionProcess } from '../src/domains/cats/services/session/import/OpenCodeLocalSessionInspection.js';
import { SessionChainStore } from '../src/domains/cats/services/stores/ports/SessionChainStore.js';
import { ThreadStore } from '../src/domains/cats/services/stores/ports/ThreadStore.js';
import { sessionChainRoutes } from '../src/routes/session-chain.js';

for (const [id, config] of Object.entries(toAllCatConfigs(loadCatConfig('../../cat-template.json'))))
  if (!catRegistry.has(id)) catRegistry.register(id, config);
catRegistry.register('f322-oc', {
  ...catRegistry.tryGet('codex')!.config,
  id: createCatId('f322-oc'),
  clientId: 'opencode',
  cli: { command: 'opencode' },
});
delete process.env.DEFAULT_OWNER_USER_ID;

test('OpenCode list, preflight, native binding and duplicate rejection share the exact native ID', async () => {
  const threads = new ThreadStore();
  const sessions = new SessionChainStore();
  const thread = threads.create('u', undefined, '/project');
  const metadata = {
    sessionId: 'ses_original',
    clientId: 'opencode' as const,
    firstPrompt: '',
    projectPath: '/project',
    lastActivityAt: 1,
    turnCount: null,
  };
  const app = Fastify();
  await app.register(sessionChainRoutes, {
    threadStore: threads,
    sessionChainStore: sessions,
    inspectLocalSession: async () => metadata,
    listLocalSessions: async () => ({ sessions: [metadata], limited: false }),
  });
  try {
    const headers = { 'x-cat-cafe-user': 'u' };
    assert.equal(
      (await app.inject({ url: '/api/local-sessions/f322-oc', headers })).json().sessions[0].sessionId,
      'ses_original',
    );
    assert.equal((await app.inject({ url: '/api/local-sessions/f322-oc/ses_original', headers })).statusCode, 200);
    assert.equal((await app.inject({ url: '/api/local-sessions/codex/ses_original', headers })).statusCode, 400);
    const bound = await app.inject({
      method: 'PATCH',
      url: `/api/threads/${thread.id}/sessions/f322-oc/bind`,
      headers,
      payload: { cliSessionId: 'ses_original', externalImport: true },
    });
    assert.equal(bound.statusCode, 200);
    assert.equal(bound.json().session.externalImport.clientId, 'opencode');
    assert.equal((await app.inject({ url: '/api/local-sessions/f322-oc/ses_original', headers })).statusCode, 409);
  } finally {
    await app.close();
  }
});

test('known Cafe rows are omitted without leaking another user’s bound name', async () => {
  const threads = new ThreadStore();
  const sessions = new SessionChainStore();
  const hidden = threads.create('private', 'Private name');
  sessions.create({
    catId: 'codex',
    userId: 'private',
    threadId: hidden.id,
    cliSessionId: '019aaaaa-1111-7111-8111-111111111111',
  });
  const app = Fastify();
  await app.register(sessionChainRoutes, {
    threadStore: threads,
    sessionChainStore: sessions,
    listLocalSessions: async () => ({
      limited: false,
      sessions: [
        {
          sessionId: '019aaaaa-1111-7111-8111-111111111111',
          clientId: 'openai',
          firstPrompt: '<runtime-routing-context> This is owner-authorized routing data…',
          projectPath: '/project',
          lastActivityAt: 1,
          turnCount: null,
        },
      ],
    }),
  });
  try {
    const response = await app.inject({ url: '/api/local-sessions/codex', headers: { 'x-cat-cafe-user': 'u' } });
    assert.deepEqual(response.json().sessions, []);
    assert.ok(!response.body.includes('Private name'));
  } finally {
    await app.close();
  }
});

test('OpenCode writer detection matches the exact session rather than another carrier', () => {
  assert.equal(hasOpenCodeSessionProcess('/bin/opencode run --session ses_original prompt', 'ses_original'), true);
  assert.equal(hasOpenCodeSessionProcess('/bin/opencode run --session=ses_original prompt', 'ses_original'), true);
  assert.equal(hasOpenCodeSessionProcess('/bin/opencode run -s ses_original prompt', 'ses_original'), true);
  assert.equal(hasOpenCodeSessionProcess('/bin/opencode run --session ses_other prompt', 'ses_original'), false);
  assert.equal(hasOpenCodeSessionProcess('/bin/codex run --session ses_original', 'ses_original'), false);
});

test('OpenCode child-session preflight and external binding explain rejection without creating a claim', async () => {
  const threadStore = new ThreadStore();
  const sessionChainStore = new SessionChainStore();
  const thread = threadStore.create('u', undefined, '/project');
  const app = Fastify();
  await app.register(sessionChainRoutes, {
    threadStore,
    sessionChainStore,
    inspectLocalSession: async () => {
      throw Object.assign(new Error('Subagent session'), { code: 'SESSION_NOT_TOP_LEVEL' });
    },
  });
  try {
    const headers = { 'x-cat-cafe-user': 'u' };
    const preflight = await app.inject({ url: '/api/local-sessions/f322-oc/ses_child', headers });
    const bind = await app.inject({
      method: 'PATCH',
      url: `/api/threads/${thread.id}/sessions/f322-oc/bind`,
      headers,
      payload: { cliSessionId: 'ses_child', externalImport: true },
    });
    for (const response of [preflight, bind]) {
      assert.equal(response.statusCode, 409);
      assert.equal(response.json().code, 'SESSION_NOT_TOP_LEVEL');
      assert.match(response.json().error, /parent session/i);
    }
    assert.equal(await sessionChainStore.getByCliSessionId('ses_child'), null);
    assert.equal((await threadStore.get(thread.id))?.sessionImport, undefined);
  } finally {
    await app.close();
  }
});
