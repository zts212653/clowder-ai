/**
 * F247 AC-B1c-1: cloudCatBindings endpoint integration tests.
 *
 * Covers `GET /api/threads/:id/cloud-bindings` + `PATCH /api/threads/:id/cloud-bindings`:
 *  - Owner-only access (non-owner gets 403)
 *  - URL validation on PATCH (invalid URL → 400)
 *  - PATCH with null clears binding
 *  - Multi-cat bindings preserved across PATCH operations
 *  - Default `GET /api/threads/:id` strips cloudCatBindings (privacy)
 *  - 404 when thread does not exist / is deleted
 *
 * NOTE: tests use `codex` / `opus` as catIds (registered in cat-template.json),
 * NOT `gpt-pro` — `gpt-pro` lives only in runtime catalog (B1a `POST /api/cats`)
 * and is not picked up by `setup-cat-registry.js` test bootstrap. The route logic
 * accepts any registered catId; semantic gpt-pro coupling happens at the
 * bridge layer (B1c-2/3), out of this PR's scope.
 */

import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import Fastify from 'fastify';

const { threadsRoutes } = await import('../dist/routes/threads.js');

const AUTH_OWNER = { 'x-cat-cafe-user': 'alice' };
const AUTH_STRANGER = { 'x-cat-cafe-user': 'mallory' };

function makeFakeThreadStore({ thread, bindingsByThread = new Map() } = {}) {
  return {
    get: async (id) => (thread && id === thread.id ? thread : null),
    updateCloudCatBinding: async (id, catId, chatUrl) => {
      if (!bindingsByThread.has(id)) bindingsByThread.set(id, {});
      const b = bindingsByThread.get(id);
      if (chatUrl === null) {
        delete b[catId];
      } else {
        b[catId] = chatUrl;
      }
    },
    getCloudCatBindings: async (id) => ({ ...(bindingsByThread.get(id) ?? {}) }),
    // Other methods threadsRoutes register may need — return safe no-ops.
    list: async () => [],
    listByProject: async () => [],
  };
}

async function makeApp({ thread, bindingsByThread } = {}) {
  const store = makeFakeThreadStore({ thread, bindingsByThread });
  const app = Fastify();
  await app.register(threadsRoutes, {
    threadStore: store,
    messageStore: { getByThread: async () => [], getByThreadBefore: async () => [] },
    taskStore: { listByThread: async () => [] },
  });
  return { app, store };
}

describe('F247 AC-B1c-1: GET /api/threads/:id/cloud-bindings (owner-only)', () => {
  let app;
  afterEach(async () => {
    if (app) await app.close();
    app = null;
  });

  it('404 when thread does not exist', async () => {
    ({ app } = await makeApp({ thread: null }));
    const res = await app.inject({
      method: 'GET',
      url: '/api/threads/T1/cloud-bindings',
      headers: AUTH_OWNER,
    });
    assert.equal(res.statusCode, 404);
  });

  it('owner reads empty bindings when none set → { bindings: {} }', async () => {
    ({ app } = await makeApp({
      thread: { id: 'T1', createdBy: 'alice', deletedAt: null },
    }));
    const res = await app.inject({
      method: 'GET',
      url: '/api/threads/T1/cloud-bindings',
      headers: AUTH_OWNER,
    });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { bindings: {} });
  });

  it('owner reads existing bindings', async () => {
    const bindings = new Map([['T1', { codex: 'https://chatgpt.com/c/abc' }]]);
    ({ app } = await makeApp({
      thread: { id: 'T1', createdBy: 'alice', deletedAt: null },
      bindingsByThread: bindings,
    }));
    const res = await app.inject({
      method: 'GET',
      url: '/api/threads/T1/cloud-bindings',
      headers: AUTH_OWNER,
    });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { bindings: { codex: 'https://chatgpt.com/c/abc' } });
  });

  it('non-owner gets 403', async () => {
    ({ app } = await makeApp({
      thread: { id: 'T1', createdBy: 'alice', deletedAt: null },
    }));
    const res = await app.inject({
      method: 'GET',
      url: '/api/threads/T1/cloud-bindings',
      headers: AUTH_STRANGER,
    });
    assert.equal(res.statusCode, 403);
    const body = res.json();
    assert.match(body.error ?? '', /owner can read/);
  });

  it('404 when thread is soft-deleted (GET symmetric with PATCH)', async () => {
    // gpt52 R1 P2-2 catch: original test had a wishy-washy "either 200 or 404"
    // assertion, but the route actually 404s on `thread.deletedAt` (symmetric with
    // PATCH). Test now pins the real contract: deleted thread = inaccessible to
    // both reads and writes through this endpoint. If ops needs to clean up bindings
    // for a deleted thread, the path is: restore the thread first (existing
    // `POST /api/threads/:id/restore`), then PATCH null to clear bindings.
    ({ app } = await makeApp({
      thread: { id: 'T1', createdBy: 'alice', deletedAt: Date.now() },
    }));
    const res = await app.inject({
      method: 'GET',
      url: '/api/threads/T1/cloud-bindings',
      headers: AUTH_OWNER,
    });
    assert.equal(res.statusCode, 404);
  });
});

describe('F247 AC-B1c-1: PATCH /api/threads/:id/cloud-bindings (owner-only + URL validation)', () => {
  let app;
  afterEach(async () => {
    if (app) await app.close();
    app = null;
  });

  it('404 when thread does not exist', async () => {
    ({ app } = await makeApp({ thread: null }));
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/threads/T1/cloud-bindings',
      headers: { ...AUTH_OWNER, 'content-type': 'application/json' },
      payload: JSON.stringify({ catId: 'codex', chatUrl: 'https://chatgpt.com/c/abc' }),
    });
    assert.equal(res.statusCode, 404);
  });

  it('non-owner gets 403', async () => {
    ({ app } = await makeApp({
      thread: { id: 'T1', createdBy: 'alice', deletedAt: null },
    }));
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/threads/T1/cloud-bindings',
      headers: { ...AUTH_STRANGER, 'content-type': 'application/json' },
      payload: JSON.stringify({ catId: 'codex', chatUrl: 'https://chatgpt.com/c/abc' }),
    });
    assert.equal(res.statusCode, 403);
  });

  it('owner sets a valid binding → 200 with updated bindings', async () => {
    const bindingsMap = new Map();
    ({ app } = await makeApp({
      thread: { id: 'T1', createdBy: 'alice', deletedAt: null },
      bindingsByThread: bindingsMap,
    }));
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/threads/T1/cloud-bindings',
      headers: { ...AUTH_OWNER, 'content-type': 'application/json' },
      payload: JSON.stringify({ catId: 'codex', chatUrl: 'https://chatgpt.com/c/abc-123' }),
    });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { bindings: { codex: 'https://chatgpt.com/c/abc-123' } });
    assert.deepEqual(bindingsMap.get('T1'), { codex: 'https://chatgpt.com/c/abc-123' });
  });

  it('rejects invalid URL (http instead of https) → 400', async () => {
    ({ app } = await makeApp({
      thread: { id: 'T1', createdBy: 'alice', deletedAt: null },
    }));
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/threads/T1/cloud-bindings',
      headers: { ...AUTH_OWNER, 'content-type': 'application/json' },
      payload: JSON.stringify({ catId: 'codex', chatUrl: 'http://chatgpt.com/c/abc' }),
    });
    assert.equal(res.statusCode, 400);
  });

  it('rejects URL with query injection → 400', async () => {
    ({ app } = await makeApp({
      thread: { id: 'T1', createdBy: 'alice', deletedAt: null },
    }));
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/threads/T1/cloud-bindings',
      headers: { ...AUTH_OWNER, 'content-type': 'application/json' },
      payload: JSON.stringify({ catId: 'codex', chatUrl: 'https://chatgpt.com/c/abc?evil=1' }),
    });
    assert.equal(res.statusCode, 400);
  });

  it('rejects URL with subdomain attack → 400', async () => {
    ({ app } = await makeApp({
      thread: { id: 'T1', createdBy: 'alice', deletedAt: null },
    }));
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/threads/T1/cloud-bindings',
      headers: { ...AUTH_OWNER, 'content-type': 'application/json' },
      payload: JSON.stringify({ catId: 'codex', chatUrl: 'https://evil.chatgpt.com/c/abc' }),
    });
    assert.equal(res.statusCode, 400);
  });

  it('PATCH with chatUrl=null clears the binding → 200', async () => {
    const bindingsMap = new Map([['T1', { codex: 'https://chatgpt.com/c/abc' }]]);
    ({ app } = await makeApp({
      thread: { id: 'T1', createdBy: 'alice', deletedAt: null },
      bindingsByThread: bindingsMap,
    }));
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/threads/T1/cloud-bindings',
      headers: { ...AUTH_OWNER, 'content-type': 'application/json' },
      payload: JSON.stringify({ catId: 'codex', chatUrl: null }),
    });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { bindings: {} });
  });

  it('PATCH preserves bindings for other catIds (per-cat isolation)', async () => {
    const bindingsMap = new Map([['T1', { opus: 'https://chatgpt.com/c/xyz' }]]);
    ({ app } = await makeApp({
      thread: { id: 'T1', createdBy: 'alice', deletedAt: null },
      bindingsByThread: bindingsMap,
    }));
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/threads/T1/cloud-bindings',
      headers: { ...AUTH_OWNER, 'content-type': 'application/json' },
      payload: JSON.stringify({ catId: 'codex', chatUrl: 'https://chatgpt.com/c/abc' }),
    });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), {
      bindings: {
        opus: 'https://chatgpt.com/c/xyz',
        codex: 'https://chatgpt.com/c/abc',
      },
    });
  });

  it('rejects missing catId → 400', async () => {
    ({ app } = await makeApp({
      thread: { id: 'T1', createdBy: 'alice', deletedAt: null },
    }));
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/threads/T1/cloud-bindings',
      headers: { ...AUTH_OWNER, 'content-type': 'application/json' },
      payload: JSON.stringify({ chatUrl: 'https://chatgpt.com/c/abc' }),
    });
    assert.equal(res.statusCode, 400);
  });
});

// ─────────────────────────────────────────────────────────────
// gpt52 R2 P0 fix: strict auth model — no system exemption, no default user
// fallback. cloudCatBindings endpoints are sensitive operational sidecar and
// MUST be gated by strict identity + strict owner match. These fixtures pin
// the regression.
// ─────────────────────────────────────────────────────────────
describe('F247 AC-B1c-1 R2: strict auth model (gpt52 R2 P0 regression)', () => {
  let app;
  afterEach(async () => {
    if (app) await app.close();
    app = null;
  });

  it('401 when no auth header on GET', async () => {
    ({ app } = await makeApp({
      thread: { id: 'T1', createdBy: 'alice', deletedAt: null },
    }));
    const res = await app.inject({
      method: 'GET',
      url: '/api/threads/T1/cloud-bindings',
      // No x-cat-cafe-user header
    });
    assert.equal(res.statusCode, 401);
  });

  it('401 when no auth header on PATCH', async () => {
    ({ app } = await makeApp({
      thread: { id: 'T1', createdBy: 'alice', deletedAt: null },
    }));
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/threads/T1/cloud-bindings',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ catId: 'codex', chatUrl: 'https://chatgpt.com/c/abc' }),
    });
    assert.equal(res.statusCode, 401);
  });

  it('403 when stranger calls GET on a system-owned thread (no exemption)', async () => {
    // The 'default' thread is system-created and appears in every user's sidebar.
    // Before R2 fix, a stranger could read cloud bindings from system threads via
    // the `createdBy === 'system'` exemption. Now strict owner match: createdBy
    // must equal authenticated userId.
    ({ app } = await makeApp({
      thread: { id: 'default', createdBy: 'system', deletedAt: null },
    }));
    const res = await app.inject({
      method: 'GET',
      url: '/api/threads/default/cloud-bindings',
      headers: AUTH_STRANGER,
    });
    assert.equal(res.statusCode, 403);
  });

  it('403 when stranger PATCHes a system-owned thread', async () => {
    ({ app } = await makeApp({
      thread: { id: 'default', createdBy: 'system', deletedAt: null },
    }));
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/threads/default/cloud-bindings',
      headers: { ...AUTH_STRANGER, 'content-type': 'application/json' },
      payload: JSON.stringify({ catId: 'codex', chatUrl: 'https://chatgpt.com/c/abc' }),
    });
    assert.equal(res.statusCode, 403);
  });

  it('403 when authenticated user is not the owner', async () => {
    ({ app } = await makeApp({
      thread: { id: 'T1', createdBy: 'alice', deletedAt: null },
    }));
    const res = await app.inject({
      method: 'GET',
      url: '/api/threads/T1/cloud-bindings',
      headers: AUTH_STRANGER,
    });
    assert.equal(res.statusCode, 403);
  });
});

// ─────────────────────────────────────────────────────────────
// gpt52 R3 P0 fix: header spoof of reserved identity `system` / `scheduler`
// MUST be rejected at the auth layer. R2 fix narrowed the bypass from
// "any caller" to "any non-browser caller that sets x-cat-cafe-user: system",
// AND my R2 test wishfully codified that residual bypass as expected behavior
// (the "200 when literal system header" test — that was a bug self-deception).
//
// R3 adds defense-in-depth: (a) reserved-identity reject at auth layer,
// (b) system-thread reject at thread layer. Either alone closes the bypass;
// both together follow F077 R9 owner-only pattern + F24 P1-3 reserved discipline.
// ─────────────────────────────────────────────────────────────
describe('F247 AC-B1c-1 R3: reserved-identity reject + system-thread reject (gpt52 R3 P0 regression)', () => {
  let app;
  afterEach(async () => {
    if (app) await app.close();
    app = null;
  });

  it('401 when x-cat-cafe-user: system on GET (reserved-identity reject)', async () => {
    // R2 test wishfully said "200 here is OK since system is internal-only".
    // gpt52 R3 proved this is a real header-spoof bypass against the system-owned
    // `default` thread. R3: reject reserved identity at the auth layer.
    ({ app } = await makeApp({
      thread: { id: 'default', createdBy: 'system', deletedAt: null },
    }));
    const res = await app.inject({
      method: 'GET',
      url: '/api/threads/default/cloud-bindings',
      headers: { 'x-cat-cafe-user': 'system' },
    });
    assert.equal(res.statusCode, 401);
  });

  it('401 when x-cat-cafe-user: system on PATCH (reserved-identity reject)', async () => {
    ({ app } = await makeApp({
      thread: { id: 'default', createdBy: 'system', deletedAt: null },
    }));
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/threads/default/cloud-bindings',
      headers: { 'x-cat-cafe-user': 'system', 'content-type': 'application/json' },
      payload: JSON.stringify({ catId: 'codex', chatUrl: 'https://chatgpt.com/c/abc' }),
    });
    assert.equal(res.statusCode, 401);
  });

  it('401 when x-cat-cafe-user: scheduler (other reserved identity)', async () => {
    ({ app } = await makeApp({
      thread: { id: 'T1', createdBy: 'alice', deletedAt: null },
    }));
    const res = await app.inject({
      method: 'GET',
      url: '/api/threads/T1/cloud-bindings',
      headers: { 'x-cat-cafe-user': 'scheduler' },
    });
    assert.equal(res.statusCode, 401);
  });

  it('403 when authenticated user requests cloud-bindings on a system-owned thread', async () => {
    // Defense-in-depth: even if R1 layer somehow let a reserved identity through,
    // system-owned threads MUST refuse cloud bindings. Semantic: system threads
    // (default lobby / connector hub / eval domain) have no user-owner concept
    // for cloud cat binding.
    ({ app } = await makeApp({
      thread: { id: 'default', createdBy: 'system', deletedAt: null },
    }));
    const res = await app.inject({
      method: 'GET',
      url: '/api/threads/default/cloud-bindings',
      headers: AUTH_OWNER,
    });
    assert.equal(res.statusCode, 403);
    const body = res.json();
    assert.match(body.error ?? '', /system-owned/);
  });

  it('403 when authenticated user PATCHes a system-owned thread', async () => {
    ({ app } = await makeApp({
      thread: { id: 'default', createdBy: 'system', deletedAt: null },
    }));
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/threads/default/cloud-bindings',
      headers: { ...AUTH_OWNER, 'content-type': 'application/json' },
      payload: JSON.stringify({ catId: 'codex', chatUrl: 'https://chatgpt.com/c/abc' }),
    });
    assert.equal(res.statusCode, 403);
    const body = res.json();
    assert.match(body.error ?? '', /system-owned/);
  });
});

describe('F247 AC-B1c-8: privacy — default GET /api/threads/:id strips cloudCatBindings', () => {
  let app;
  afterEach(async () => {
    if (app) await app.close();
    app = null;
  });

  it('GET /api/threads/:id does NOT include cloudCatBindings in response', async () => {
    const thread = {
      id: 'T1',
      projectPath: 'default',
      title: 'demo',
      createdBy: 'alice',
      participants: [],
      lastActiveAt: 0,
      createdAt: 0,
      cloudCatBindings: { codex: 'https://chatgpt.com/c/abc' },
    };
    ({ app } = await makeApp({ thread }));
    const res = await app.inject({
      method: 'GET',
      url: '/api/threads/T1',
      headers: AUTH_OWNER,
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.cloudCatBindings, undefined, 'cloudCatBindings MUST be stripped from default GET');
    assert.equal(body.id, 'T1');
    assert.equal(body.title, 'demo');
  });
});
