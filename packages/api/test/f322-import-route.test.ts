import { catRegistry } from '@cat-cafe/shared';
import { loadCatConfig, toAllCatConfigs } from '../src/config/cat-config-loader.js';

for (const [id, config] of Object.entries(toAllCatConfigs(loadCatConfig('../../cat-template.json')))) {
  if (!catRegistry.has(id)) catRegistry.register(id, config);
}

import assert from 'node:assert/strict';
import { test } from 'node:test';
import Fastify from 'fastify';
import { SessionChainStore } from '../src/domains/cats/services/stores/ports/SessionChainStore.js';
import { ThreadStore } from '../src/domains/cats/services/stores/ports/ThreadStore.js';
import { sessionChainRoutes } from '../src/routes/session-chain.js';

// Native import fixtures use local single-user mode. Owner-gate denial and
// configured-owner success are covered in f322-recent-sessions.test.ts.
delete process.env.DEFAULT_OWNER_USER_ID;

const id = '019aaaaa-1111-7111-8111-111111111111';
async function fixture(locked = false) {
  const threads = new ThreadStore();
  const sessions = new SessionChainStore();
  const app = Fastify();
  const thread = threads.create('u', undefined, '/project');
  await app.register(sessionChainRoutes, {
    threadStore: threads,
    sessionChainStore: sessions,
    inspectLocalSession: async () => {
      if (locked) throw Object.assign(new Error('active writer'), { code: 'SESSION_ACTIVE_WRITER' });
      return {
        sessionId: id,
        clientId: 'openai',
        projectPath: '/project',
        firstPrompt: 'fix import',
        lastActivityAt: 123,
        turnCount: null,
      };
    },
  });
  return { app, thread, threads, sessions };
}

test('locked import is rejected before making a binding', async () => {
  const f = await fixture(true);
  try {
    const r = await f.app.inject({
      method: 'PATCH',
      url: `/api/threads/${f.thread.id}/sessions/codex/bind`,
      headers: { 'x-cat-cafe-user': 'u' },
      payload: { cliSessionId: id, externalImport: true },
    });
    assert.equal(r.statusCode, 409);
    assert.equal(r.json().code, 'SESSION_ACTIVE_WRITER');
    assert.equal(f.sessions.getByCliSessionId(id), null);
  } finally {
    await f.app.close();
  }
});

test('import persists the native origin and rejects a second thread; replaying the first binding is safe', async () => {
  const f = await fixture();
  try {
    const request = {
      method: 'PATCH' as const,
      url: `/api/threads/${f.thread.id}/sessions/codex/bind`,
      headers: { 'x-cat-cafe-user': 'u' },
      payload: { cliSessionId: id, externalImport: true },
    };
    const first = await f.app.inject(request);
    assert.equal(first.statusCode, 200);
    assert.equal(first.json().session.externalImport.cliSessionId, id);
    assert.deepEqual(f.threads.get(f.thread.id)?.sessionImport, {
      sessionId: first.json().session.id,
      catId: 'codex',
    });
    assert.equal((await f.app.inject(request)).statusCode, 200);
    const second = f.threads.create('u', undefined, '/project');
    const duplicate = await f.app.inject({ ...request, url: `/api/threads/${second.id}/sessions/codex/bind` });
    assert.equal(duplicate.statusCode, 409);
    assert.equal(duplicate.json().code, 'SESSION_ALREADY_BOUND');
  } finally {
    await f.app.close();
  }
});

test('origin projection never enumerates a chain for ordinary or imported conversations', async () => {
  const f = await fixture();
  try {
    const probe = () =>
      f.app.inject({ url: `/api/threads/${f.thread.id}/sessions?view=import`, headers: { 'x-cat-cafe-user': 'u' } });
    let chainReads = 0;
    f.sessions.getChainByThread = () => {
      chainReads++;
      return [];
    };
    assert.equal((await probe()).json().importedSession, null);
    assert.equal(chainReads, 0);
    await f.app.inject({
      method: 'PATCH',
      url: `/api/threads/${f.thread.id}/sessions/codex/bind`,
      headers: { 'x-cat-cafe-user': 'u' },
      payload: { cliSessionId: id, externalImport: true },
    });
    assert.equal((await probe()).json().importedSession.cliSessionId, id);
    assert.equal(chainReads, 0);
    const active = f.sessions.getActive('codex', f.thread.id, 'u');
    assert.ok(active);
    f.sessions.update(active.id, { cliSessionId: 'a-different-native' });
    assert.equal((await probe()).json().importedSession, null);
    assert.equal(chainReads, 0);
  } finally {
    await f.app.close();
  }
});

test('import rejects a different project and never exposes another user’s thread coordinates', async () => {
  const f = await fixture();
  try {
    const wrong = f.threads.create('u', undefined, '/other');
    const r = await f.app.inject({
      method: 'PATCH',
      url: `/api/threads/${wrong.id}/sessions/codex/bind`,
      headers: { 'x-cat-cafe-user': 'u' },
      payload: { cliSessionId: id, externalImport: true },
    });
    assert.equal(r.statusCode, 409);
    assert.equal(f.sessions.getByCliSessionId(id), null);
    const other = f.threads.create('other', 'Private', '/project');
    f.sessions.create({ threadId: other.id, catId: 'codex', userId: 'other', cliSessionId: id });
    const probe = await f.app.inject({ url: `/api/local-sessions/codex/${id}`, headers: { 'x-cat-cafe-user': 'u' } });
    assert.equal(probe.statusCode, 409);
    assert.equal(probe.json().boundThread, undefined);
  } finally {
    await f.app.close();
  }
});

test('cloud-only ChatGPT members cannot inspect a local Codex session', async () => {
  const f = await fixture();
  try {
    const r = await f.app.inject({ url: `/api/local-sessions/gpt-pro/${id}`, headers: { 'x-cat-cafe-user': 'u' } });
    assert.equal(r.statusCode, 400);
  } finally {
    await f.app.close();
  }
});

test('a failed CLI-ID claim never projects a connected origin card', async () => {
  const f = await fixture();
  f.sessions.bindCliSessionId = () => null;
  try {
    const failed = await f.app.inject({
      method: 'PATCH',
      url: `/api/threads/${f.thread.id}/sessions/codex/bind`,
      headers: { 'x-cat-cafe-user': 'u' },
      payload: { cliSessionId: id, externalImport: true },
    });
    assert.equal(failed.statusCode, 409);
    const projection = await f.app.inject({
      url: `/api/threads/${f.thread.id}/sessions?view=import`,
      headers: { 'x-cat-cafe-user': 'u' },
    });
    assert.equal(projection.json().importedSession, null);
  } finally {
    await f.app.close();
  }
});
