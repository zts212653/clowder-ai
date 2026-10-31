import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

/**
 * F300 Task 1.6 — who is asking is proven, not asserted.
 *
 * Reviewed 2026-09-07 (codex-astra, finding 10). The first draft read `?catId=`
 * and let the MCP tool pass whatever it liked, which meant the answer to "what
 * is my own state" was shaped by the caller's claim about itself, and any
 * remote caller could ask.
 *
 * These cases run the real MCP handler against the real route through an
 * in-process transport. Nothing here opens a port or reaches a live deployment.
 */
describe('home state caller binding', () => {
  const INVOCATION = { invocationId: 'inv-f300', callbackToken: 'token-f300' };
  const RECORD = {
    invocationId: INVOCATION.invocationId,
    userId: 'default-user',
    catId: 'codex-astra',
    threadId: 'thread-f300',
    state: 'active',
  };

  let Fastify;
  let homeStateRoutes;
  let quotaRoutes;
  let resetQuotaCachesForTests;
  let handleHomeStateSelf;
  let savedEnv;
  let savedFetch;
  let catRegistry;

  before(async () => {
    Fastify = (await import('fastify')).default;
    ({ homeStateRoutes } = await import('../../dist/routes/home-state.js'));
    ({ quotaRoutes, resetQuotaCachesForTests } = await import('../../dist/routes/quota.js'));
    ({ handleHomeStateSelf } = await import('../../../mcp-server/dist/tools/home-state-tools.js'));
    ({ catRegistry } = await import('@cat-cafe/shared'));
    // Registered so the cat's client really does map to a seeded, exhausted
    // platform pool: the negative (quota stays unknown) only means something
    // if the tempting attribution is available.
    catRegistry.register('codex-astra', { id: 'codex-astra', name: 'Astra', clientId: 'openai' });
    savedEnv = { ...process.env };
    savedFetch = globalThis.fetch;
  });

  after(() => {
    process.env = savedEnv;
    globalThis.fetch = savedFetch;
  });

  /** Accepts exactly one credential pair, like the real registry does. */
  const callbackRegistry = {
    verify: async (invocationId, callbackToken) =>
      invocationId === INVOCATION.invocationId && callbackToken === INVOCATION.callbackToken
        ? { ok: true, record: RECORD }
        : { ok: false, reason: 'unknown_invocation' },
  };

  async function appWithExhaustedCodexPool() {
    const app = Fastify();
    await app.register(quotaRoutes);
    await app.register(homeStateRoutes, { apiPort: 39002, callbackRegistry });
    const seeded = await app.inject({
      method: 'PATCH',
      url: '/api/quota/codex',
      payload: { usageItems: [{ label: 'Weekly limit', usedPercent: 100, percentKind: 'used' }] },
    });
    assert.equal(seeded.statusCode, 200, seeded.body);
    return app;
  }

  it('binds the facet to the invocation that presented credentials', async () => {
    const app = await appWithExhaustedCodexPool();
    try {
      const response = await app.inject({
        url: '/api/home-state/self',
        remoteAddress: '203.0.113.8',
        headers: { 'x-invocation-id': INVOCATION.invocationId, 'x-callback-token': INVOCATION.callbackToken },
      });

      assert.equal(response.statusCode, 200, response.body);
      const facet = response.json();
      assert.equal(facet.coordinates.catId, 'codex-astra');
      assert.equal(facet.coordinates.threadId, 'thread-f300');
      assert.equal(facet.coordinates.invocationId, INVOCATION.invocationId);
    } finally {
      await app.close();
      resetQuotaCachesForTests();
    }
  });

  it('ignores a forged identity in the query when credentials say otherwise', async () => {
    const app = await appWithExhaustedCodexPool();
    try {
      const facet = (
        await app.inject({
          url: '/api/home-state/self?catId=someone-else&threadId=forged&invocationId=forged',
          remoteAddress: '203.0.113.8',
          headers: { 'x-invocation-id': INVOCATION.invocationId, 'x-callback-token': INVOCATION.callbackToken },
        })
      ).json();

      assert.equal(facet.coordinates.catId, 'codex-astra');
      assert.equal(facet.coordinates.threadId, 'thread-f300');
      assert.equal(facet.coordinates.invocationId, INVOCATION.invocationId);
    } finally {
      await app.close();
      resetQuotaCachesForTests();
    }
  });

  it('refuses a remote caller whose credentials do not verify', async () => {
    const app = await appWithExhaustedCodexPool();
    try {
      const response = await app.inject({
        url: '/api/home-state/self?catId=codex-astra',
        remoteAddress: '203.0.113.8',
        headers: { 'x-invocation-id': INVOCATION.invocationId, 'x-callback-token': 'wrong-token' },
      });
      assert.ok([401, 403].includes(response.statusCode), `status=${response.statusCode}`);
    } finally {
      await app.close();
      resetQuotaCachesForTests();
    }
  });

  it('refuses a remote caller presenting nothing at all', async () => {
    const app = await appWithExhaustedCodexPool();
    try {
      const response = await app.inject({ url: '/api/home-state/self', remoteAddress: '203.0.113.8' });
      assert.equal(response.statusCode, 401, `status=${response.statusCode}`);
    } finally {
      await app.close();
      resetQuotaCachesForTests();
    }
  });

  /**
   * A real tool call carries the calling cat's proven identity end to end.
   *
   * This used to also assert the cat's quota came back `exhausted`, reached by
   * mapping its registered client (openai) onto the codex platform pool. #4545
   * review R3: a client names a provider, not the account this invocation bills,
   * so that reading was someone's pool attributed to this cat. The pool here is
   * seeded exhausted on purpose -- the facet must still say unknown.
   */
  it('carries the calling cat from the MCP tool, without attributing a pool to it', async () => {
    const app = await appWithExhaustedCodexPool();
    process.env.CAT_CAFE_INVOCATION_ID = INVOCATION.invocationId;
    process.env.CAT_CAFE_CALLBACK_TOKEN = INVOCATION.callbackToken;
    process.env.CAT_CAFE_API_URL = 'http://127.0.0.1:39002';
    globalThis.fetch = async (url, init) => {
      const target = new URL(url);
      const response = await app.inject({
        url: target.pathname + target.search,
        headers: init?.headers ?? {},
        remoteAddress: '203.0.113.8',
      });
      return { ok: response.statusCode === 200, status: response.statusCode, json: async () => response.json() };
    };

    try {
      const result = await handleHomeStateSelf();
      const facet = JSON.parse(result.content[0].text);
      assert.equal(facet.coordinates.catId, 'codex-astra');
      assert.equal(facet.quota, 'unknown', JSON.stringify(facet.quota));
    } finally {
      await app.close();
      resetQuotaCachesForTests();
    }
  });

  it('says so plainly when this process cannot prove who it is', async () => {
    delete process.env.CAT_CAFE_INVOCATION_ID;
    delete process.env.CAT_CAFE_CALLBACK_TOKEN;
    delete process.env.CAT_CAFE_AGENT_KEY_SECRET;
    delete process.env.CAT_CAFE_CREDENTIAL_FILE;

    const result = await handleHomeStateSelf();
    assert.match(result.content[0].text, /credentials|prove who it is/i);
  });
});
