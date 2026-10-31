/**
 * F167 PR-2 — GET /api/callbacks/custody-events.
 *
 * Invocation identity only: the thread is the authenticated invocation's own and no request parameter can change
 * it, and an agent key (which carries no thread) is refused in v1. Inputs are a required `sourceMessageId` and an
 * optional `limit` of 1..50. The two ways a read can fail to be a plain answer stay explicit in the HTTP response:
 * the ledger being unreadable is a 503 with its reason, never a 200 with an empty list.
 */
import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';
import Fastify from 'fastify';

const AGENT_KEY = { agentKeyId: 'ak-1', catId: 'codex-terra', userId: 'owner-user', scope: 'user-bound' };

describe('F167 custody events route', () => {
  let registry;
  let threadStore;

  beforeEach(async () => {
    const { InvocationRegistry } = await import(
      '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js'
    );
    const { ThreadStore } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');
    registry = new InvocationRegistry();
    threadStore = new ThreadStore();
  });

  function inspectorStub(result) {
    const calls = [];
    return {
      calls,
      async inspect(input) {
        calls.push(input);
        return typeof result === 'function' ? result(input) : result;
      },
    };
  }

  async function createApp(holdBallDeps, { agentKey = false } = {}) {
    const { callbacksRoutes } = await import('../dist/routes/callbacks.js');
    const app = Fastify();
    await app.register(callbacksRoutes, {
      registry,
      ...(agentKey
        ? {
            agentKeyRegistry: {
              async verify(secret) {
                return secret === 'agent-key-secret'
                  ? { ok: true, record: AGENT_KEY }
                  : { ok: false, reason: 'agent_key_unknown' };
              },
            },
          }
        : {}),
      messageStore: {
        async getMessagesForThread() {
          return [];
        },
      },
      socketManager: { broadcastAgentMessage() {}, getMessages: () => [] },
      threadStore,
      evidenceStore: {
        async store() {},
        async search() {
          return [];
        },
      },
      markerQueue: { enqueue() {} },
      reflectionService: { async run() {} },
      holdBallDeps: {
        registry,
        holdQuotaStore: {
          async tryAdmit() {
            return { admitted: true, count: 1, eventId: 'e' };
          },
          async releaseByEventId() {
            return true;
          },
          async getCount() {
            return 0;
          },
          async close() {},
        },
        ...holdBallDeps,
      },
    });
    return app;
  }

  async function callerHeaders(threadId) {
    const { invocationId, callbackToken } = await registry.create('user-1', 'codex', threadId);
    return { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken };
  }

  const ok = (overrides = {}) => ({
    status: 'ok',
    threadId: 'x',
    sourceMessageId: 'src-1',
    limit: 20,
    found: true,
    anchorSequence: 0,
    events: [],
    truncated: false,
    subjectEventCount: 1,
    projection: { status: 'not_found' },
    ...overrides,
  });

  test("reads the AUTHENTICATED invocation's own thread, whatever the query asks for", async () => {
    const own = await threadStore.create('user-1', 'own');
    const inspector = inspectorStub(ok());
    const app = await createApp({ custodyEventInspector: inspector });

    const response = await app.inject({
      method: 'GET',
      url: '/api/callbacks/custody-events?sourceMessageId=src-1&limit=5',
      headers: await callerHeaders(own.id),
    });

    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(inspector.calls, [{ threadId: own.id, sourceMessageId: 'src-1', limit: 5 }]);
    assert.equal(JSON.parse(response.body).status, 'ok');
    await app.close();
  });

  test('a thread parameter is refused outright, so another thread can never be asked for', async () => {
    const own = await threadStore.create('user-1', 'own');
    const inspector = inspectorStub(ok());
    const app = await createApp({ custodyEventInspector: inspector });

    for (const extra of ['threadId=thread-other', 'thread=thread-other', 'subjectKey=ball:thread:thread-other']) {
      const response = await app.inject({
        method: 'GET',
        url: `/api/callbacks/custody-events?sourceMessageId=src-1&${extra}`,
        headers: await callerHeaders(own.id),
      });
      assert.equal(response.statusCode, 400, `${extra}: ${response.body}`);
    }
    assert.deepEqual(inspector.calls, [], 'nothing was read for any of them');
    await app.close();
  });

  test('the limit defaults inside the inspector, and 0, 51, a fraction or a word is refused with 400', async () => {
    const own = await threadStore.create('user-1', 'own');
    const inspector = inspectorStub(ok());
    const app = await createApp({ custodyEventInspector: inspector });
    const headers = await callerHeaders(own.id);

    const noLimit = await app.inject({
      method: 'GET',
      url: '/api/callbacks/custody-events?sourceMessageId=src-1',
      headers,
    });
    assert.equal(noLimit.statusCode, 200, noLimit.body);
    assert.deepEqual(inspector.calls.at(-1), { threadId: own.id, sourceMessageId: 'src-1' });

    for (const limit of ['0', '51', '1.5', 'many', '-3']) {
      const response = await app.inject({
        method: 'GET',
        url: `/api/callbacks/custody-events?sourceMessageId=src-1&limit=${limit}`,
        headers,
      });
      assert.equal(response.statusCode, 400, `limit=${limit}: ${response.body}`);
    }
    const missing = await app.inject({ method: 'GET', url: '/api/callbacks/custody-events', headers });
    assert.equal(missing.statusCode, 400, 'sourceMessageId is required');
    assert.equal(inspector.calls.length, 1, 'only the valid call reached the inspector');
    await app.close();
  });

  test('without callback credentials it is 401, and an agent key is refused 403 (v1 is invocation identity only)', async () => {
    const inspector = inspectorStub(ok());
    const app = await createApp({ custodyEventInspector: inspector }, { agentKey: true });

    const anonymous = await app.inject({ method: 'GET', url: '/api/callbacks/custody-events?sourceMessageId=src-1' });
    assert.equal(anonymous.statusCode, 401, anonymous.body);

    const agentKey = await app.inject({
      method: 'GET',
      url: '/api/callbacks/custody-events?sourceMessageId=src-1',
      headers: { 'x-agent-key-secret': 'agent-key-secret' },
    });
    assert.equal(agentKey.statusCode, 403, agentKey.body);
    assert.deepEqual(inspector.calls, []);
    await app.close();
  });

  test('found:false is a 200 with that fact, and an unreadable ledger is a 503 with its reason', async () => {
    const own = await threadStore.create('user-1', 'own');
    const app = await createApp({
      custodyEventInspector: inspectorStub((input) =>
        input.sourceMessageId === 'src-unreadable'
          ? { status: 'unavailable', reason: 'event_log_read_failed' }
          : ok({ found: false, events: [], anchorSequence: undefined }),
      ),
    });
    const headers = await callerHeaders(own.id);

    const none = await app.inject({
      method: 'GET',
      url: '/api/callbacks/custody-events?sourceMessageId=src-none',
      headers,
    });
    assert.equal(none.statusCode, 200, none.body);
    assert.equal(JSON.parse(none.body).found, false);

    const broken = await app.inject({
      method: 'GET',
      url: '/api/callbacks/custody-events?sourceMessageId=src-unreadable',
      headers,
    });
    assert.equal(broken.statusCode, 503, broken.body);
    assert.deepEqual(JSON.parse(broken.body), { status: 'unavailable', reason: 'event_log_read_failed' });
    await app.close();
  });

  test('the real inspector behind the route: free text under an allowed key never reaches the HTTP response', async () => {
    const { CustodyEventInspector } = await import('../dist/domains/ball-custody/CustodyEventInspector.js');
    const { buildDispatchDispositionEvent } = await import('../dist/domains/ball-custody/ball-custody-events.js');
    const own = await threadStore.create('user-1', 'own');
    const sentinel = 'PRIVATE NOTE SENTINEL: arbitrary free text, not a custody code';
    const terminal = buildDispatchDispositionEvent({
      threadId: own.id,
      catId: 'codex-sol',
      fromCatId: 'sonnet',
      invocationId: 'inv-1',
      sourceMessageId: 'src-1',
      disposition: 'handled',
      via: 'direct',
      at: 2_000,
    });
    const stored = { ...terminal, payload: { ...terminal.payload, disposition: sentinel, via: sentinel } };
    const inspector = new CustodyEventInspector({
      ballCustodyEventLog: {
        async read() {
          return [stored];
        },
      },
      ballCustodyProjectionStore: {
        async get() {
          return null;
        },
      },
    });
    const app = await createApp({ custodyEventInspector: inspector });

    const response = await app.inject({
      method: 'GET',
      url: '/api/callbacks/custody-events?sourceMessageId=src-1',
      headers: await callerHeaders(own.id),
    });

    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.body.includes('SENTINEL'), false, response.body);
    assert.deepEqual(JSON.parse(response.body).events[0].unrecognizedFields, ['disposition', 'via']);
    await app.close();
  });

  test('a runtime without the ledger answers 503 CUSTODY_INSPECTOR_UNAVAILABLE instead of an empty result', async () => {
    const own = await threadStore.create('user-1', 'own');
    const app = await createApp({});

    const response = await app.inject({
      method: 'GET',
      url: '/api/callbacks/custody-events?sourceMessageId=src-1',
      headers: await callerHeaders(own.id),
    });

    assert.equal(response.statusCode, 503, response.body);
    assert.equal(JSON.parse(response.body).code, 'CUSTODY_INSPECTOR_UNAVAILABLE');
    await app.close();
  });
});
