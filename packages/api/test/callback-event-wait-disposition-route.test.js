/**
 * F167 — POST /api/callbacks/complete-event-wait.
 *
 * Invocation identity only (an agent key carries no invocation and is refused). The caller supplies exactly one
 * thing, `handled | completed`; the wake, its carrier and the holder are server-derived, so no body key can name
 * another thread, wait, outcome or message.
 */
import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';
import Fastify from 'fastify';
import { BallCustodyIngest } from '../dist/domains/ball-custody/BallCustodyIngest.js';
import { BallCustodyProjector } from '../dist/domains/ball-custody/BallCustodyProjector.js';
import { buildHandedEvent } from '../dist/domains/ball-custody/ball-custody-events.js';
import {
  EventWaitDispositionError,
  EventWaitDispositionService,
} from '../dist/domains/ball-custody/EventWaitDispositionService.js';
import { realWaitWake } from './helpers/event-wait-terminal-fixture.js';
import { MemoryEventLog, MemoryProjectionStore } from './helpers/memory-ball-custody.js';

const AGENT_KEY = { agentKeyId: 'ak-1', catId: 'codex-terra', userId: 'owner-user', scope: 'user-bound' };
const URL = '/api/callbacks/complete-event-wait';

describe('F167 complete-event-wait route', () => {
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

  function serviceStub(result) {
    const calls = [];
    return {
      calls,
      async complete(record, disposition) {
        calls.push({ record, disposition });
        if (typeof result === 'function') return result(record, disposition);
        return result;
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

  async function callerHeaders(threadId, originTriggerMessageId) {
    const { invocationId, callbackToken } = await registry.create(
      'user-1',
      'codex',
      threadId,
      undefined,
      undefined,
      undefined,
      originTriggerMessageId,
    );
    return { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken };
  }

  const applied = (overrides = {}) => ({
    outcome: 'applied',
    disposition: 'completed',
    invocationId: 'inv',
    sourceMessageId: 'wake-1',
    waitId: 'wait-1',
    outcomeId: 'wait:deployment:x:runtime:g2:matched',
    retired: false,
    ...overrides,
  });

  test('hands the authenticated invocation record and only the disposition to the service', async () => {
    const own = await threadStore.create('user-1', 'own');
    const service = serviceStub(applied());
    const app = await createApp({ eventWaitDispositionService: service });
    const headers = await callerHeaders(own.id, 'wake-1');

    const response = await app.inject({ method: 'POST', url: URL, headers, payload: { disposition: 'completed' } });

    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(JSON.parse(response.body), applied());
    assert.equal(service.calls.length, 1);
    assert.equal(service.calls[0].disposition, 'completed');
    assert.equal(service.calls[0].record.threadId, own.id, "the thread is the authenticated invocation's own");
    assert.equal(service.calls[0].record.invocationId, headers['x-invocation-id']);
    assert.equal(service.calls[0].record.originTriggerMessageId, 'wake-1');
    await app.close();
  });

  test('the body is strict: only `disposition`, and only handled | completed', async () => {
    const own = await threadStore.create('user-1', 'own');
    const service = serviceStub(applied());
    const app = await createApp({ eventWaitDispositionService: service });
    const headers = await callerHeaders(own.id, 'wake-1');

    for (const payload of [
      {},
      { disposition: 'done' },
      { disposition: 'handled', threadId: 'thread-other' },
      { disposition: 'handled', sourceMessageId: 'wake-2' },
      { disposition: 'handled', outcomeId: 'wait:other:g1:matched' },
      { disposition: 'handled', waitId: 'wait-2' },
      { disposition: 'handled', retired: true },
    ]) {
      const response = await app.inject({ method: 'POST', url: URL, headers, payload });
      assert.equal(response.statusCode, 400, `${JSON.stringify(payload)}: ${response.body}`);
    }
    assert.deepEqual(service.calls, [], 'nothing reached the service');
    await app.close();
  });

  test('no callback credentials is 401, and an agent key (no invocation) is refused', async () => {
    const service = serviceStub(applied());
    const app = await createApp({ eventWaitDispositionService: service }, { agentKey: true });

    const anonymous = await app.inject({ method: 'POST', url: URL, payload: { disposition: 'handled' } });
    assert.equal(anonymous.statusCode, 401, anonymous.body);

    const agentKey = await app.inject({
      method: 'POST',
      url: URL,
      headers: { 'x-agent-key-secret': 'agent-key-secret' },
      payload: { disposition: 'handled' },
    });
    assert.ok([401, 403].includes(agentKey.statusCode), agentKey.body);
    assert.deepEqual(service.calls, []);
    await app.close();
  });

  test('a runtime without the ledger answers 503 EVENT_WAIT_DISPOSITION_UNAVAILABLE instead of pretending', async () => {
    const own = await threadStore.create('user-1', 'own');
    const app = await createApp({});

    const response = await app.inject({
      method: 'POST',
      url: URL,
      headers: await callerHeaders(own.id, 'wake-1'),
      payload: { disposition: 'handled' },
    });

    assert.equal(response.statusCode, 503, response.body);
    assert.equal(JSON.parse(response.body).code, 'EVENT_WAIT_DISPOSITION_UNAVAILABLE');
    await app.close();
  });

  test('a typed refusal is a 409 carrying its code; anything else is not dressed up as one', async () => {
    const own = await threadStore.create('user-1', 'own');
    const refused = await createApp({
      eventWaitDispositionService: serviceStub(() => {
        throw new EventWaitDispositionError('event_wait_disposition_not_event_wait');
      }),
    });
    const response = await refused.inject({
      method: 'POST',
      url: URL,
      headers: await callerHeaders(own.id, 'wake-1'),
      payload: { disposition: 'handled' },
    });
    assert.equal(response.statusCode, 409, response.body);
    assert.equal(JSON.parse(response.body).code, 'event_wait_disposition_not_event_wait');
    await refused.close();

    const broken = await createApp({
      eventWaitDispositionService: serviceStub(() => {
        throw new Error('redis exploded');
      }),
    });
    const crashed = await broken.inject({
      method: 'POST',
      url: URL,
      headers: await callerHeaders(own.id, 'wake-1'),
      payload: { disposition: 'handled' },
    });
    assert.equal(crashed.statusCode, 500, crashed.body);
    await broken.close();
  });

  test('end to end through real callback auth and the real service: a woken holder completes its matched wake', async () => {
    const own = await threadStore.create('user-1', 'own');
    const wake = realWaitWake('matched', { holderCatId: 'codex', subjectKey: `ball:thread:${own.id}` });
    const carrier = wake.waitContinuationCarrier;
    const eventLog = new MemoryEventLog();
    const projectionStore = new MemoryProjectionStore();
    const ingest = new BallCustodyIngest(eventLog, new BallCustodyProjector(eventLog, projectionStore));
    await ingest.record(buildHandedEvent({ threadId: own.id, toCatId: 'codex', messageId: 'wake-1', at: 1_000 }));
    const service = new EventWaitDispositionService({
      registry,
      messageStore: {
        async getById(id) {
          return id === 'wake-1'
            ? {
                id,
                threadId: own.id,
                source: { connector: 'deployment-wait', meta: { waitContinuationCarrier: carrier } },
              }
            : null;
        },
      },
      ballCustodyEventLog: eventLog,
      ballCustodyProjectionStore: projectionStore,
      ballCustody: ingest,
    });
    const app = await createApp({ eventWaitDispositionService: service });

    const response = await app.inject({
      method: 'POST',
      url: URL,
      headers: await callerHeaders(own.id, 'wake-1'),
      payload: { disposition: 'handled' },
    });

    assert.equal(response.statusCode, 200, response.body);
    const body = JSON.parse(response.body);
    assert.equal(body.outcome, 'applied');
    assert.equal(body.outcomeId, carrier.outcomeId);
    assert.equal(
      eventLog.events.filter((event) => event.kind === 'ball.wait_dispositioned').length,
      1,
      "exactly one terminal in the caller's own thread ledger",
    );
    await app.close();
  });
});
