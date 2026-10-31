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

// These fixtures model local single-user mode; dedicated owner cases below
// explicitly exercise configured ownership without inheriting runtime identity.
delete process.env.DEFAULT_OWNER_USER_ID;

const nativeId = (n: number) => `019aaaaa-1111-7111-8111-${String(n).padStart(12, '0')}`;
const metadata = (n: number) => ({
  sessionId: nativeId(n),
  clientId: 'openai' as const,
  projectPath: '/original',
  firstPrompt: `Original task ${n}`,
  lastActivityAt: n,
  turnCount: null,
});

test('recent metadata is lazy, capped, and duplicates use one bulk index lookup with access-safe links', async () => {
  const threads = new ThreadStore();
  const sessions = new SessionChainStore();
  const owned = threads.create('owner', 'My imported work');
  const privateThread = threads.create('someone-else', 'Private title');
  for (const [thread, n, userId] of [
    [owned, 2, 'owner'],
    [privateThread, 3, 'someone-else'],
  ] as const) {
    const record = sessions.create({ threadId: thread.id, userId, catId: 'codex', cliSessionId: nativeId(n) });
    sessions.update(record.id, {
      externalImport: {
        cliSessionId: nativeId(n),
        clientId: 'openai',
        projectPath: '/original',
        firstPrompt: '',
        lastActivityAt: n,
        importedAt: 1,
      },
    });
  }
  let listings = 0;
  let requestedLimit = 0;
  let bulkReads = 0;
  const indexed = sessions.getCliSessionBindings?.bind(sessions);
  sessions.getCliSessionBindings = async (ids) => {
    bulkReads++;
    assert.ok(ids.length <= 200);
    return indexed(ids);
  };
  sessions.getByCliSessionId = () => {
    throw new Error('No serial per-session lookup');
  };
  sessions.getChainByThread = () => {
    throw new Error('No full chain scans');
  };
  const options = {
    threadStore: threads,
    sessionChainStore: sessions,
    listLocalSessions: async (catId: string, limit: number) => {
      listings++;
      requestedLimit = limit;
      assert.equal(catId, 'codex');
      return {
        sessions: Array.from({ length: 30 }, (_, n) => ({ ...metadata(n + 1), lastActivityAt: 30 - n })),
        limited: true,
      };
    },
  };
  const app = Fastify();
  await app.register(sessionChainRoutes, options);
  try {
    assert.equal(listings, 0, 'route registration must not read native history');
    const response = await app.inject({
      url: '/api/local-sessions/codex?limit=20',
      headers: { 'x-cat-cafe-user': 'owner' },
    });
    assert.equal(response.statusCode, 200);
    const rows = response.json().sessions;
    assert.equal(listings, 1);
    assert.equal(requestedLimit, 200);
    assert.equal(bulkReads, 1);
    assert.equal(rows.length, 20);
    assert.deepEqual(rows.find((s: { sessionId: string }) => s.sessionId === nativeId(2)).boundThread, {
      id: owned.id,
      title: 'My imported work',
    });
    const hidden = rows.find((s: { sessionId: string }) => s.sessionId === nativeId(3));
    assert.equal(hidden.alreadyBound, true);
    assert.equal(hidden.boundThread, undefined);
    assert.ok(!response.body.includes('Private title'));
    assert.ok(!response.body.includes(privateThread.id));
  } finally {
    await app.close();
  }
});

test('listing rejects cloud members and invalid limits before calling a provider; failure preserves ID admission', async () => {
  let listings = 0;
  const options = {
    threadStore: new ThreadStore(),
    sessionChainStore: new SessionChainStore(),
    listLocalSessions: async () => {
      listings++;
      throw new Error('native index unavailable');
    },
    inspectLocalSession: async () => metadata(1),
  };
  const app = Fastify();
  await app.register(sessionChainRoutes, options);
  try {
    for (const url of [
      '/api/local-sessions/gpt-pro',
      '/api/local-sessions/codex?limit=21',
      '/api/local-sessions/codex?limit=oops',
    ])
      assert.equal((await app.inject({ url, headers: { 'x-cat-cafe-user': 'owner' } })).statusCode, 400);
    assert.equal(listings, 0);
    assert.equal(
      (await app.inject({ url: '/api/local-sessions/codex', headers: { 'x-cat-cafe-user': 'owner' } })).statusCode,
      503,
    );
    const byId = await app.inject({
      url: `/api/local-sessions/codex/${nativeId(1)}`,
      headers: { 'x-cat-cafe-user': 'owner' },
    });
    assert.equal(byId.statusCode, 200);
  } finally {
    await app.close();
  }
});

test('memory bulk lookup returns only current claims, including sealed sessions, and no invented IDs', async () => {
  const store = new SessionChainStore();
  const one = store.create({ userId: 'owner', threadId: 't', catId: 'codex', cliSessionId: nativeId(1) });
  store.update(one.id, { status: 'sealed' });
  assert.equal(typeof store.getCliSessionBindings, 'function');
  const claims = await store.getCliSessionBindings([nativeId(1), nativeId(1), nativeId(2)]);
  assert.equal(claims.size, 1);
  assert.equal(claims.get(nativeId(1))?.threadId, 't');
  assert.equal(claims.get(nativeId(1))?.isExternalImport, false);
  store.update(one.id, { status: 'active' });
  store.bindCliSessionId(one.id, nativeId(3));
  assert.equal((await store.getCliSessionBindings([nativeId(1)])).size, 0);
});

test('known Cafe sessions are removed before the public limit while imported external sessions keep access-safe links', async () => {
  const threadStore = new ThreadStore();
  const sessionChainStore = new SessionChainStore();
  const cafeThread = threadStore.create('owner', 'Cafe origin');
  const imported = threadStore.create('owner', 'Imported human work');
  for (let i = 1; i <= 25; i++)
    sessionChainStore.create({ threadId: cafeThread.id, userId: 'owner', catId: 'codex', cliSessionId: nativeId(i) });
  const adopted = sessionChainStore.create({
    threadId: imported.id,
    userId: 'owner',
    catId: 'codex',
    cliSessionId: nativeId(26),
  });
  sessionChainStore.update(adopted.id, {
    externalImport: {
      cliSessionId: nativeId(26),
      clientId: 'openai',
      projectPath: '/original',
      firstPrompt: '',
      lastActivityAt: 26,
      importedAt: 1,
    },
  });
  const app = Fastify();
  await app.register(sessionChainRoutes, {
    threadStore,
    sessionChainStore,
    listLocalSessions: async () => ({
      sessions: Array.from({ length: 50 }, (_, i) => ({ ...metadata(i + 1), lastActivityAt: 50 - i })),
      limited: false,
    }),
    inspectLocalSession: async () => metadata(1),
  });
  try {
    const response = await app.inject({
      url: '/api/local-sessions/codex?limit=20',
      headers: { 'x-cat-cafe-user': 'owner' },
    });
    assert.equal(response.statusCode, 200);
    const result = response.json();
    assert.equal(result.sessions.length, 20);
    assert.equal(result.sessions[0].sessionId, nativeId(26));
    assert.deepEqual(result.sessions[0].boundThread, { id: imported.id, title: 'Imported human work' });
    assert.equal(result.limited, true);
    const pasted = await app.inject({
      url: `/api/local-sessions/codex/${nativeId(1)}`,
      headers: { 'x-cat-cafe-user': 'owner' },
    });
    assert.equal(pasted.statusCode, 409, 'the existing claim is still reported on the ID path');
  } finally {
    await app.close();
  }
});

for (const path of ['list', 'inspect', 'externalBind'] as const) {
  test(`${path} checks the configured host owner before reading native sessions; single-user mode still works`, async () => {
    const previousOwner = process.env.DEFAULT_OWNER_USER_ID;
    try {
      for (const scenario of [
        { configured: 'owner', user: 'intruder', expected: 403, legacy: false },
        { configured: 'owner', user: 'owner', expected: 200, legacy: false },
        { configured: undefined, user: 'intruder', expected: 200, legacy: false },
        ...(path === 'externalBind' ? [{ configured: 'owner', user: 'intruder', expected: 200, legacy: true }] : []),
      ]) {
        if (scenario.configured) process.env.DEFAULT_OWNER_USER_ID = scenario.configured;
        else delete process.env.DEFAULT_OWNER_USER_ID;
        const threads = new ThreadStore();
        const sessions = new SessionChainStore();
        const thread = threads.create(scenario.user, undefined, '/original');
        let nativeReads = 0;
        const app = Fastify();
        await app.register(sessionChainRoutes, {
          threadStore: threads,
          sessionChainStore: sessions,
          listLocalSessions: async () => {
            nativeReads++;
            return { sessions: [metadata(1)], limited: false };
          },
          inspectLocalSession: async () => {
            nativeReads++;
            return metadata(1);
          },
        });
        try {
          const response = await app.inject({
            method: path === 'externalBind' ? 'PATCH' : 'GET',
            url:
              path === 'list'
                ? '/api/local-sessions/codex'
                : path === 'inspect'
                  ? `/api/local-sessions/codex/${nativeId(1)}`
                  : `/api/threads/${thread.id}/sessions/codex/bind`,
            headers: { 'x-cat-cafe-user': scenario.user },
            ...(path === 'externalBind'
              ? { payload: { cliSessionId: nativeId(1), ...(!scenario.legacy ? { externalImport: true } : {}) } }
              : {}),
          });
          assert.equal(response.statusCode, scenario.expected, `${path}: ${scenario.configured}/${scenario.user}`);
          assert.equal(nativeReads, scenario.expected === 403 || scenario.legacy ? 0 : 1);
          if (scenario.expected === 403) {
            assert.equal(response.json().code, 'SESSION_OWNER_REQUIRED');
            assert.equal(sessions.getByCliSessionId(nativeId(1)), null);
          }
        } finally {
          await app.close();
        }
      }
    } finally {
      if (previousOwner === undefined) delete process.env.DEFAULT_OWNER_USER_ID;
      else process.env.DEFAULT_OWNER_USER_ID = previousOwner;
    }
  });
}
