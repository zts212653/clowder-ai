/**
 * F167 C1 — hold-ball callback route C1 per-fire sample span event
 *
 * Verdict 2026-06-12-eval-a2a-c1-zombie-hold-samples-build (PR #2244): the
 * single-slot replacement path emits a `c1.zombie_hold_fired` span event
 * carrying HMAC-pseudonymized ids + wake-delay bucket trigger so attribution
 * can classify replacements. Sibling to `callback-hold-ball-route-scheduling.test.js`
 * (split per PR #1290 cloud P2 file-size guidance).
 *
 * Uses InMemorySpanExporter (test SDK pattern from
 * `test/telemetry/mention-dispatch-trace.test.js`) to capture the emitted span +
 * event without depending on the production exporter chain.
 *
 * Scope: this test does NOT exercise RedactingSpanProcessor — the redactor is
 * tested in `test/telemetry/local-trace-exporter.test.js`. Here we assert the
 * raw event payload shape (keys + non-empty values) that the redactor will see.
 */

import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';
import Fastify from 'fastify';

const { InMemorySpanExporter, SimpleSpanProcessor, NodeTracerProvider } = await import('@opentelemetry/sdk-trace-node');

const otelExporter = new InMemorySpanExporter();
const otelProvider = new NodeTracerProvider({
  spanProcessors: [new SimpleSpanProcessor(otelExporter)],
});
otelProvider.register();

describe('F192 D — C1 zombie-hold per-fire sample span event (eval:a2a 2026-06-12 build verdict)', () => {
  let registry;
  let threadStore;

  function makeStubDeps() {
    const insertedTasks = [];
    const unregisteredIds = [];
    const removedIds = [];
    const defaultTemplate = {
      createSpec(taskId, taskParams) {
        return { taskId, taskParams };
      },
    };
    return {
      registry,
      taskRunner: {
        registerDynamic() {},
        unregister(id) {
          unregisteredIds.push(id);
          return true;
        },
      },
      templateRegistry: {
        get(id) {
          return id === 'reminder' ? defaultTemplate : undefined;
        },
      },
      dynamicTaskStore: {
        insert(record) {
          insertedTasks.push(record);
        },
        getAll() {
          return insertedTasks.filter((t) => !removedIds.includes(t.id));
        },
        remove(id) {
          removedIds.push(id);
          return true;
        },
      },
      messageStore: {
        async append(msg) {
          return { id: `test-msg-${insertedTasks.length}`, ...msg };
        },
      },
      socketManager: {
        broadcastToRoom() {},
      },
      // R1 P1-2 (砚砚): hold-ball route now derives thread.system_kind from
      // threadStore at cancel time — proxy to the real ThreadStore so updateSystemKind
      // calls in the test surface via the route handler's lookup.
      threadStore: {
        async get(threadId) {
          return threadStore.get(threadId);
        },
      },
    };
  }

  beforeEach(async () => {
    const { InvocationRegistry } = await import(
      '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js'
    );
    const { ThreadStore } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');
    registry = new InvocationRegistry();
    threadStore = new ThreadStore();
    otelExporter.reset();
  });

  async function createApp(holdBallDeps) {
    const { callbacksRoutes } = await import('../dist/routes/callbacks.js');
    const app = Fastify();
    await app.register(callbacksRoutes, {
      registry,
      messageStore: {
        async getMessagesForThread() {
          return [];
        },
      },
      socketManager: {
        broadcastAgentMessage() {},
      },
      threadStore,
      holdBallDeps,
    });
    return app;
  }

  test('emits c1.zombie_hold_fired span event with HMAC ids + wake-delay bucket trigger on replacement', async () => {
    const deps = makeStubDeps();
    const app = await createApp(deps);
    const thread = await threadStore.create('user-c1-sample', 'c1sample');
    const { invocationId, callbackToken } = await registry.create('user-c1-sample', 'codex', thread.id);
    const headers = { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken };

    // First hold — schedules a wake at 5_000ms (prior_imminent bucket when replaced quickly)
    const r1 = await app.inject({
      method: 'POST',
      url: '/api/callbacks/hold-ball',
      headers,
      payload: { reason: 'wait-A', nextStep: 'continue-A', wakeAfterMs: 5_000 },
    });
    assert.equal(r1.statusCode, 200);
    const firstTaskId = JSON.parse(r1.body).taskId;

    // Reset exporter so we only see spans from the SECOND request (which triggers replacement).
    otelExporter.reset();

    // Second hold — replaces the first. Prior fireAt was ~5s out → prior_imminent bucket.
    const r2 = await app.inject({
      method: 'POST',
      url: '/api/callbacks/hold-ball',
      headers,
      payload: { reason: 'wait-B', nextStep: 'continue-B', wakeAfterMs: 60_000 },
    });
    assert.equal(r2.statusCode, 200);
    const secondTaskId = JSON.parse(r2.body).taskId;

    const spans = otelExporter.getFinishedSpans();
    const sampleSpan = spans.find((s) => s.name === 'cat_cafe.a2a.c1.zombie_hold_sample');
    assert.ok(
      sampleSpan,
      `must emit a cat_cafe.a2a.c1.zombie_hold_sample span; got names: ${JSON.stringify(spans.map((s) => s.name))}`,
    );

    const events = sampleSpan.events ?? [];
    assert.equal(events.length, 1, 'one fire event per cancellation');
    const [event] = events;
    assert.equal(event.name, 'c1.zombie_hold_fired');

    const attrs = event.attributes ?? {};
    // Class C — raw values here (redactor would HMAC on export, not in test exporter)
    assert.equal(attrs.messageId, firstTaskId, 'messageId carries the prior (cancelled) task id');
    assert.equal(typeof attrs.invocationId, 'string');
    assert.ok(attrs.invocationId.length > 0);
    assert.equal(attrs.threadId, thread.id);
    // Class D / labels
    assert.equal(attrs['agent.id'], 'codex');
    assert.equal(attrs['thread.system_kind'], 'product');
    // Trigger: prior task was scheduled 5s out, second hold posted immediately → prior_imminent
    assert.equal(attrs.trigger, 'prior_imminent');
    // Pre-hashed (key not in Class C allowlist)
    assert.ok(typeof attrs.priorTaskIdHash === 'string' && attrs.priorTaskIdHash.length > 0);
    assert.ok(typeof attrs.newTaskIdHash === 'string' && attrs.newTaskIdHash.length > 0);
    // Hashes are distinct (different inputs)
    assert.notEqual(attrs.priorTaskIdHash, attrs.newTaskIdHash);
    // priorTaskIdHash matches messageId-via-redactor identity (both come from hmacId(prior.id))
    // — we don't assert hash format here (redactor scope), just that they're populated.

    // Sanity: cancel side effects also happened
    assert.notEqual(firstTaskId, secondTaskId);
    assert.ok(deps.dynamicTaskStore.getAll().length === 1);
    assert.equal(deps.dynamicTaskStore.getAll()[0].id, secondTaskId);
  });

  test('no span emitted when there is no prior hold to cancel (first hold)', async () => {
    const deps = makeStubDeps();
    const app = await createApp(deps);
    const thread = await threadStore.create('user-c1-nofire', 'c1nofire');
    const { invocationId, callbackToken } = await registry.create('user-c1-nofire', 'codex', thread.id);
    const headers = { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken };

    otelExporter.reset();

    const r = await app.inject({
      method: 'POST',
      url: '/api/callbacks/hold-ball',
      headers,
      payload: { reason: 'first', nextStep: 'continue', wakeAfterMs: 10_000 },
    });
    assert.equal(r.statusCode, 200);

    const sampleSpans = otelExporter.getFinishedSpans().filter((s) => s.name === 'cat_cafe.a2a.c1.zombie_hold_sample');
    assert.equal(sampleSpans.length, 0, 'no sample span on first hold (no prior to cancel)');
  });

  test('trigger=prior_long when prior was scheduled far in the future', async () => {
    const deps = makeStubDeps();
    const app = await createApp(deps);
    const thread = await threadStore.create('user-c1-long', 'c1long');
    const { invocationId, callbackToken } = await registry.create('user-c1-long', 'codex', thread.id);
    const headers = { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken };

    // Schedule prior at 30 minutes out (well above the prior_long boundary of 5min).
    await app.inject({
      method: 'POST',
      url: '/api/callbacks/hold-ball',
      headers,
      payload: { reason: 'long-wait', nextStep: 'await-external', wakeAfterMs: 30 * 60_000 },
    });

    otelExporter.reset();

    await app.inject({
      method: 'POST',
      url: '/api/callbacks/hold-ball',
      headers,
      payload: { reason: 'new-wait', nextStep: 'pivot', wakeAfterMs: 60_000 },
    });

    const sampleSpan = otelExporter.getFinishedSpans().find((s) => s.name === 'cat_cafe.a2a.c1.zombie_hold_sample');
    assert.ok(sampleSpan, 'sample span must emit on replacement');
    assert.equal(sampleSpan.events[0].attributes.trigger, 'prior_long');
  });

  test('R1 P1-2 (砚砚): thread.system_kind derived from threadStore (eval_domain thread emits eval_domain label)', async () => {
    const deps = makeStubDeps();
    const app = await createApp(deps);
    const thread = await threadStore.create('user-c1-eval', 'c1eval');
    // Mark this thread as an eval-domain thread (e.g. harness eval flow).
    await threadStore.updateSystemKind(thread.id, 'eval_domain');
    const { invocationId, callbackToken } = await registry.create('user-c1-eval', 'codex', thread.id);
    const headers = { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken };

    await app.inject({
      method: 'POST',
      url: '/api/callbacks/hold-ball',
      headers,
      payload: { reason: 'wait-A', nextStep: 'continue-A', wakeAfterMs: 5_000 },
    });
    otelExporter.reset();
    await app.inject({
      method: 'POST',
      url: '/api/callbacks/hold-ball',
      headers,
      payload: { reason: 'wait-B', nextStep: 'continue-B', wakeAfterMs: 60_000 },
    });

    const sampleSpan = otelExporter.getFinishedSpans().find((s) => s.name === 'cat_cafe.a2a.c1.zombie_hold_sample');
    assert.ok(sampleSpan, 'sample span must emit on replacement');
    assert.equal(
      sampleSpan.events[0].attributes['thread.system_kind'],
      'eval_domain',
      'thread.system_kind must be derived from threadStore — eval_domain threads must classify as such',
    );
  });

  test('R1 P1-2: connector_hub thread → thread.system_kind=connector_hub', async () => {
    const deps = makeStubDeps();
    const app = await createApp(deps);
    const thread = await threadStore.create('user-c1-hub', 'c1hub');
    await threadStore.updateSystemKind(thread.id, 'connector_hub');
    const { invocationId, callbackToken } = await registry.create('user-c1-hub', 'codex', thread.id);
    const headers = { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken };

    await app.inject({
      method: 'POST',
      url: '/api/callbacks/hold-ball',
      headers,
      payload: { reason: 'wait-A', nextStep: 'continue-A', wakeAfterMs: 5_000 },
    });
    otelExporter.reset();
    await app.inject({
      method: 'POST',
      url: '/api/callbacks/hold-ball',
      headers,
      payload: { reason: 'wait-B', nextStep: 'continue-B', wakeAfterMs: 60_000 },
    });

    const sampleSpan = otelExporter.getFinishedSpans().find((s) => s.name === 'cat_cafe.a2a.c1.zombie_hold_sample');
    assert.ok(sampleSpan);
    assert.equal(sampleSpan.events[0].attributes['thread.system_kind'], 'connector_hub');
  });
});
