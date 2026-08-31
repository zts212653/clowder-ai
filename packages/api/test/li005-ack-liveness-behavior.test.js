/**
 * LI-005 P2 — A2A ack-liveness end-to-end behavior tests.
 *
 * Proves the full chain from routeSerial through ack-liveness detection:
 *   1. Queue A2A with no exit -> hint + ball.void_ack
 *   2. Successful durable trigger -> no hint/void
 *   3. Failed trigger (400/error) -> still produces hint/void
 *   4. ball.void_ack -> ingest -> projector -> projection state = void
 *
 * Pattern follows route-serial-phase-h-hint.test.js mock architecture:
 *   - createCapturingService / createDurableTriggerService for mock agents
 *   - createMockDeps with ballCustody mock capturing recorded events
 *   - Real cat roster + routeSerial with a2aTriggerMessageId in options
 *
 * Sol R7: "R8 至少需证明这四条主路径行为"
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { catRegistry } from '@cat-cafe/shared';

// Ball-custody for scenario 4 (ingest -> projector -> void)
import { BallCustodyIngest } from '../dist/domains/ball-custody/BallCustodyIngest.js';
import { BallCustodyProjector } from '../dist/domains/ball-custody/BallCustodyProjector.js';
import { buildVoidAckEvent } from '../dist/domains/ball-custody/ball-custody-events.js';

// ---------------------------------------------------------------------------
// Serialization lock — catRegistry is global; serialize all registry-mutating tests.
// ---------------------------------------------------------------------------
let catRegistryLock = Promise.resolve();

async function withCatRegistryLock(fn) {
  const previous = catRegistryLock;
  let release;
  catRegistryLock = new Promise((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    return await fn();
  } finally {
    release();
  }
}

// ---------------------------------------------------------------------------
// Mock services
// ---------------------------------------------------------------------------

/** Simple text-only response — no tools, no routing exit. */
function createCapturingService(catId, text) {
  return {
    async *invoke() {
      yield { type: 'text', catId, content: text, timestamp: Date.now() };
      yield { type: 'done', catId, timestamp: Date.now() };
    },
  };
}

/** No-text response — only tool calls (no text content). Codex R1 P2-1 test. */
function createToolOnlyService(catId, toolName, toolInput, resultContent, resultStatus) {
  const toolUseId = `tu-notext-${Date.now()}`;
  return {
    async *invoke() {
      yield {
        type: 'tool_use',
        catId,
        toolName,
        toolInput: toolInput ?? {},
        toolUseId,
        id: toolUseId,
        timestamp: Date.now(),
      };
      yield {
        type: 'tool_result',
        catId,
        content: resultContent,
        toolResultStatus: resultStatus,
        toolUseId,
        timestamp: Date.now(),
      };
      yield { type: 'done', catId, timestamp: Date.now() };
    },
  };
}

/** Service that calls post_message with targetCats (structured routing). P2-2 test. */
function createPostMessageService(catId, text, targetCats, resultContent, resultConfirmed) {
  const toolUseId = `tu-pm-${Date.now()}`;
  return {
    async *invoke() {
      if (text) yield { type: 'text', catId, content: text, timestamp: Date.now() };
      yield {
        type: 'tool_use',
        catId,
        toolName: 'cat_cafe_post_message',
        toolInput: { content: 'review this', targetCats },
        toolUseId,
        id: toolUseId,
        timestamp: Date.now(),
      };
      yield {
        type: 'tool_result',
        catId,
        content: resultConfirmed
          ? `{"status":"ok","messageId":"pm-msg-1","threadId":"thr-pm"}`
          : `{"error":"delivery_failed","code":500}`,
        toolResultStatus: resultConfirmed ? 'ok' : 'error',
        toolUseId,
        timestamp: Date.now(),
      };
      yield { type: 'done', catId, timestamp: Date.now() };
    },
  };
}

/**
 * Service that calls a durable trigger tool and yields tool_use + tool_result.
 * Simulates the bridge all three carriers now provide (Claude print/bg/PTY).
 */
function createDurableTriggerService(catId, text, toolName, toolInput, resultContent, resultStatus) {
  const toolUseId = `tu-test-${Date.now()}`;
  return {
    async *invoke() {
      yield { type: 'text', catId, content: text, timestamp: Date.now() };
      yield {
        type: 'tool_use',
        catId,
        toolName,
        toolInput: toolInput ?? {},
        toolUseId,
        id: toolUseId,
        timestamp: Date.now(),
      };
      yield {
        type: 'tool_result',
        catId,
        content: resultContent,
        toolResultStatus: resultStatus,
        toolUseId,
        timestamp: Date.now(),
      };
      yield { type: 'done', catId, timestamp: Date.now() };
    },
  };
}

// ---------------------------------------------------------------------------
// Mock deps (adapted from route-serial-phase-h-hint.test.js)
// ---------------------------------------------------------------------------

function createMockDeps(services, appendedMessages, recordedBallEvents) {
  let counter = 0;
  return {
    services,
    invocationDeps: {
      registry: {
        create: () => ({ invocationId: `inv-${++counter}`, callbackToken: `tok-${counter}` }),
        verify: async () => ({ ok: false, reason: 'unknown_invocation' }),
      },
      sessionManager: {
        get: async () => null,
        getOrCreate: async () => ({}),
        resolveWorkingDirectory: () => '/tmp/test',
      },
      threadStore: null,
      apiUrl: 'http://127.0.0.1:3004',
    },
    messageStore: {
      append: async (msg) => {
        const stored = {
          id: `msg-${++counter}`,
          userId: msg.userId ?? '',
          catId: msg.catId ?? null,
          content: msg.content ?? '',
          mentions: msg.mentions ?? [],
          timestamp: msg.timestamp ?? 0,
          source: msg.source,
        };
        appendedMessages.push(stored);
        return stored;
      },
      getById: () => null,
      getRecent: () => [],
      getMentionsFor: () => [],
      getBefore: () => [],
      getByThread: () => [],
      getByThreadAfter: () => [],
      getByThreadBefore: () => [],
      augmentStreamMetadata: async () => null,
    },
    // LI-005: ball-custody mock capturing recorded events
    ballCustody: recordedBallEvents ? { record: async (event) => recordedBallEvents.push(event) } : undefined,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function loadRealRoster() {
  const { loadCatConfig, toAllCatConfigs } = await import('../dist/config/cat-config-loader.js');
  const runtimeConfigs = toAllCatConfigs(loadCatConfig());
  catRegistry.reset();
  for (const [id, config] of Object.entries(runtimeConfigs)) {
    catRegistry.register(id, config);
  }
}

/**
 * Run routeSerial with queue A2A options (a2aTriggerMessageId).
 * Returns appended messages + ball custody events.
 */
async function runA2ARoute(opusService, opts = {}) {
  return withCatRegistryLock(async () => {
    const original = catRegistry.getAllConfigs();
    await loadRealRoster();
    const appended = [];
    const ballEvents = [];
    try {
      const { routeSerial } = await import('../dist/domains/cats/services/agents/routing/route-serial.js');
      const codexService = createCapturingService('codex', 'ack');
      const deps = createMockDeps({ opus: opusService, codex: codexService }, appended, ballEvents);
      for await (const _ of routeSerial(deps, ['opus'], 'A2A test prompt', 'user1', 'thread-ack-test', {
        thinkingMode: 'play',
        a2aTriggerMessageId: opts.a2aTriggerMessageId ?? 'trigger-msg-queue-test',
      })) {
        // drain
      }
      return { appended, ballEvents };
    } finally {
      catRegistry.reset();
      for (const [id, config] of Object.entries(original)) {
        catRegistry.register(id, config);
      }
    }
  });
}

// ---------------------------------------------------------------------------
// In-memory ball-custody stubs for scenario 4 (same pattern as ingest.test.js)
// ---------------------------------------------------------------------------

function memLog() {
  const events = [];
  const seen = new Set();
  return {
    append: async (e) => {
      if (seen.has(e.sourceEventId)) return { appended: false, sequence: -1 };
      seen.add(e.sourceEventId);
      events.push(e);
      return { appended: true, sequence: events.length - 1 };
    },
    read: async (sk) => events.filter((e) => e.subjectKey === sk),
    listSubjects: async () => [...new Set(events.map((e) => e.subjectKey))],
  };
}

function memStore() {
  const m = new Map();
  return {
    get: async (k) => (m.has(k) ? JSON.parse(JSON.stringify(m.get(k))) : null),
    save: async (p) => m.set(p.subjectKey, JSON.parse(JSON.stringify(p))),
    listSubjectKeys: async () => [...m.keys()],
    delete: async (k) => m.delete(k),
  };
}

// ===========================================================================
// Scenario 1: Queue A2A with no exit -> hint + ball.void_ack
// ===========================================================================

describe('LI-005 scenario 1: queue A2A no exit -> hint + ball.void_ack', () => {
  test('A2A invocation with plain text (no tool, no @exit) emits ack-liveness-hint', async () => {
    const opusService = createCapturingService('opus', 'I looked at the code but found nothing actionable.');
    const { appended } = await runA2ARoute(opusService);

    const hint = appended.find((m) => m.source?.connector === 'ack-liveness-hint');
    assert.ok(hint, 'must emit ack-liveness-hint when A2A invocation has no exit');
    assert.equal(hint.userId, 'system');
    assert.equal(hint.catId, null);
    assert.match(hint.content, /接球提醒/);
    assert.match(hint.content, /hold_ball|触发器/);
    assert.equal(hint.source.icon, '🏓');
    assert.equal(hint.source.meta.presentation, 'system_notice');
    assert.equal(hint.source.meta.noticeTone, 'warning');
  });

  test('A2A invocation with no exit emits ball.void_ack event', async () => {
    const opusService = createCapturingService('opus', 'Done reviewing, nothing to do.');
    const { ballEvents } = await runA2ARoute(opusService);

    const voidAck = ballEvents.find((e) => e.kind === 'ball.void_ack');
    assert.ok(voidAck, 'must emit ball.void_ack when A2A invocation has no exit');
    assert.match(voidAck.subjectKey, /^ball:thread:/);
    assert.equal(voidAck.classification, 'state-changing');
  });
});

// ===========================================================================
// Scenario 2: Successful durable trigger -> no hint/void
// ===========================================================================

describe('LI-005 scenario 2: successful durable trigger -> no hint/void', () => {
  test('hold_ball with ok result suppresses ack-liveness-hint', async () => {
    const opusService = createDurableTriggerService(
      'opus',
      'Holding ball while waiting for CI.',
      'cat_cafe_hold_ball',
      { wakeAfterMs: 300000 },
      '{"status":"ok","held":true,"taskId":"hold-42"}',
      'ok',
    );
    const { appended, ballEvents } = await runA2ARoute(opusService);

    const hint = appended.find((m) => m.source?.connector === 'ack-liveness-hint');
    assert.equal(hint, undefined, 'successful hold_ball must suppress ack-liveness-hint');

    const voidAck = ballEvents.find((e) => e.kind === 'ball.void_ack');
    assert.equal(voidAck, undefined, 'successful hold_ball must not emit ball.void_ack');
  });

  test('register_scheduled_task with success:true suppresses hint', async () => {
    const opusService = createDurableTriggerService(
      'opus',
      'Scheduling follow-up check.',
      'cat_cafe_register_scheduled_task',
      { cronExpression: '0 */6 * * *' },
      '{"success":true,"task":{"id":"sched-1"}}',
      'ok',
    );
    const { appended, ballEvents } = await runA2ARoute(opusService);

    const hint = appended.find((m) => m.source?.connector === 'ack-liveness-hint');
    assert.equal(hint, undefined, 'successful register_scheduled_task must suppress hint');

    const voidAck = ballEvents.find((e) => e.kind === 'ball.void_ack');
    assert.equal(voidAck, undefined, 'successful register_scheduled_task must not emit void_ack');
  });

  test('register_pr_tracking with status:ok suppresses hint', async () => {
    const opusService = createDurableTriggerService(
      'opus',
      'Tracking PR #123.',
      'cat_cafe_register_pr_tracking',
      { prUrl: 'https://github.com/org/repo/pull/123' },
      '{"status":"ok","threadId":"thr-pr","task":{"id":"pr-1"}}',
      'ok',
    );
    const { appended, ballEvents } = await runA2ARoute(opusService);

    const hint = appended.find((m) => m.source?.connector === 'ack-liveness-hint');
    assert.equal(hint, undefined, 'successful PR tracking must suppress hint');
    assert.equal(
      ballEvents.find((e) => e.kind === 'ball.void_ack'),
      undefined,
      'no void_ack on successful PR tracking',
    );
  });

  test('successful structured dispatch completion suppresses the legacy liveness hint', async () => {
    const opusService = createDurableTriggerService(
      'opus',
      'The dispatched work is complete.',
      'mcp:cat-cafe/complete_a2a_dispatch',
      { disposition: 'completed' },
      '{"status":"ok","disposition":"completed"}',
      'ok',
    );
    const { appended, ballEvents } = await runA2ARoute(opusService);

    assert.equal(
      appended.find((m) => m.source?.connector === 'ack-liveness-hint'),
      undefined,
      'successful terminal disposition is a clean lifecycle exit',
    );
    assert.equal(
      ballEvents.find((e) => e.kind === 'ball.void_ack'),
      undefined,
      'successful terminal disposition must not emit ball.void_ack',
    );
  });
});

// ===========================================================================
// Scenario 3: Failed trigger -> still produces hint/void
// ===========================================================================

describe('LI-005 scenario 3: failed trigger -> hint + ball.void_ack', () => {
  test('hold_ball with error status still emits ack-liveness-hint', async () => {
    const opusService = createDurableTriggerService(
      'opus',
      'Trying to hold ball.',
      'cat_cafe_hold_ball',
      { wakeAfterMs: 300000 },
      'Rate limit exceeded',
      'error',
    );
    const { appended, ballEvents } = await runA2ARoute(opusService);

    const hint = appended.find((m) => m.source?.connector === 'ack-liveness-hint');
    assert.ok(hint, 'failed hold_ball must still emit ack-liveness-hint');
    assert.match(hint.content, /接球提醒/);

    const voidAck = ballEvents.find((e) => e.kind === 'ball.void_ack');
    assert.ok(voidAck, 'failed hold_ball must emit ball.void_ack');
  });

  test('hold_ball with unknown/no toolResultStatus and error body still emits hint', async () => {
    // Simulates provider returning tool_result without explicit status +
    // body containing error markers (Level 2 parse fails closed).
    const opusService = createDurableTriggerService(
      'opus',
      'Holding ball.',
      'cat_cafe_hold_ball',
      { wakeAfterMs: 60000 },
      '{"error":"permission_denied","code":403}',
      'unknown',
    );
    const { appended, ballEvents } = await runA2ARoute(opusService);

    const hint = appended.find((m) => m.source?.connector === 'ack-liveness-hint');
    assert.ok(hint, 'error-body hold_ball must emit ack-liveness-hint (fail-closed)');

    const voidAck = ballEvents.find((e) => e.kind === 'ball.void_ack');
    assert.ok(voidAck, 'error-body hold_ball must emit ball.void_ack');
  });

  test('non-durable tool (create_task) does not suppress hint', async () => {
    // create_task is NOT a durable trigger — it creates a panel item but
    // has no wake mechanism. The hint should still fire.
    const opusService = createDurableTriggerService(
      'opus',
      'Creating a task to track this.',
      'cat_cafe_create_task',
      { title: 'Follow up on review' },
      '{"status":"ok","taskId":"task-99"}',
      'ok',
    );
    const { appended, ballEvents } = await runA2ARoute(opusService);

    const hint = appended.find((m) => m.source?.connector === 'ack-liveness-hint');
    assert.ok(hint, 'create_task is not a durable trigger; hint must fire');

    const voidAck = ballEvents.find((e) => e.kind === 'ball.void_ack');
    assert.ok(voidAck, 'create_task does not prevent void_ack');
  });
});

// ===========================================================================
// Scenario 4: ball.void_ack -> ingest -> projector -> projection state = void
// ===========================================================================

describe('LI-005 scenario 4: ball.void_ack ingest -> projection = void', () => {
  test('void_ack event transitions projection from active to void', async () => {
    const log = memLog();
    const store = memStore();
    const proj = new BallCustodyProjector(log, store);
    const ingest = new BallCustodyIngest(log, proj);

    const threadId = 'thr-void-ack-test';
    const subjectKey = `ball:thread:${threadId}`;

    // First, establish an active projection via ball.handed
    const { buildHandedEvent } = await import('../dist/domains/ball-custody/ball-custody-events.js');
    const handedEvent = buildHandedEvent({
      fromCatId: 'codex',
      toCatId: 'opus',
      threadId,
      messageId: 'msg-handed-1',
      at: 1000,
    });
    await ingest.record(handedEvent);

    // Verify active state
    const beforeProjection = await store.get(subjectKey);
    assert.ok(beforeProjection, 'projection must exist after ball.handed');
    assert.equal(beforeProjection.state, 'active', 'state must be active after ball.handed');

    // Now emit ball.void_ack
    const voidAckEvent = buildVoidAckEvent({
      threadId,
      messageId: 'msg-void-ack-1',
      a2aTriggerMessageId: 'trigger-msg-test',
      at: 2000,
    });
    await ingest.record(voidAckEvent);

    // Verify void state
    const afterProjection = await store.get(subjectKey);
    assert.ok(afterProjection, 'projection must exist after void_ack');
    assert.equal(afterProjection.state, 'void', 'state must be void after ball.void_ack');
    assert.equal(afterProjection.appliedEventCount, 2, 'two events applied (handed + void_ack)');
  });

  test('void_ack event builds correct sourceEventId and payload', () => {
    const event = buildVoidAckEvent({
      threadId: 'thr-src-test',
      messageId: 'msg-src-1',
      a2aTriggerMessageId: 'trigger-123',
      at: 3000,
    });

    assert.equal(event.kind, 'ball.void_ack');
    assert.equal(event.sourceEventId, 'route:msg-src-1:void_ack');
    assert.equal(event.subjectKey, 'ball:thread:thr-src-test');
    assert.equal(event.classification, 'state-changing');
    assert.equal(event.at, 3000);
    assert.deepStrictEqual(event.payload, { a2aTriggerMessageId: 'trigger-123' });
  });

  test('void_ack without a2aTriggerMessageId omits payload field', () => {
    const event = buildVoidAckEvent({
      threadId: 'thr-no-trigger',
      messageId: 'msg-no-trigger',
      at: 4000,
    });

    assert.equal(event.kind, 'ball.void_ack');
    assert.deepStrictEqual(event.payload, {});
  });

  test('void_ack from new state (no prior handed) also transitions to void', async () => {
    const log = memLog();
    const store = memStore();
    const proj = new BallCustodyProjector(log, store);
    const ingest = new BallCustodyIngest(log, proj);

    const threadId = 'thr-void-from-new';
    const subjectKey = `ball:thread:${threadId}`;

    // Direct void_ack without prior state (inline serial A2A first touch)
    const voidAckEvent = buildVoidAckEvent({
      threadId,
      messageId: 'msg-direct-void',
      at: 5000,
    });
    await ingest.record(voidAckEvent);

    const projection = await store.get(subjectKey);
    assert.ok(projection, 'projection must exist');
    // new -> void transition (ball.void_ack from: set('new', ...))
    assert.equal(projection.state, 'void', 'new -> void via ball.void_ack');
  });
});

// ===========================================================================
// Scenario 5: No-text A2A turns — Codex R1 P2-1 fix
// ===========================================================================

describe('LI-005 scenario 5: no-text A2A turns (Codex P2-1)', () => {
  test('tool-only A2A invocation (no text, non-durable tool) emits ack-liveness-hint', async () => {
    // Cat responds with only a tool call (create_task — not durable), no text.
    // Before the fix, this bypassed ack-liveness entirely.
    const opusService = createToolOnlyService(
      'opus',
      'cat_cafe_create_task',
      { title: 'Track follow-up' },
      '{"status":"ok","taskId":"task-77"}',
      'ok',
    );
    const { appended, ballEvents } = await runA2ARoute(opusService);

    const hint = appended.find((m) => m.source?.connector === 'ack-liveness-hint');
    assert.ok(hint, 'no-text A2A with non-durable tool must emit ack-liveness-hint');
    assert.match(hint.content, /接球提醒/);

    const voidAck = ballEvents.find((e) => e.kind === 'ball.void_ack');
    assert.ok(voidAck, 'no-text A2A with non-durable tool must emit ball.void_ack');
  });

  test('tool-only A2A with successful hold_ball suppresses hint', async () => {
    // No text, but cat called hold_ball successfully — ball is alive.
    const opusService = createToolOnlyService(
      'opus',
      'cat_cafe_hold_ball',
      { wakeAfterMs: 60000 },
      '{"status":"ok","held":true}',
      'ok',
    );
    const { appended, ballEvents } = await runA2ARoute(opusService);

    const hint = appended.find((m) => m.source?.connector === 'ack-liveness-hint');
    assert.equal(hint, undefined, 'no-text with successful hold_ball must suppress hint');

    const voidAck = ballEvents.find((e) => e.kind === 'ball.void_ack');
    assert.equal(voidAck, undefined, 'no-text with successful hold_ball must not emit void_ack');
  });
});

// ===========================================================================
// Scenario 6: Confirmed vs unconfirmed structured routing — Codex R1 P2-2 fix
// ===========================================================================

describe('LI-005 scenario 6: confirmed structured routing (Codex P2-2)', () => {
  test('failed post_message (unconfirmed) does NOT suppress hint', async () => {
    // Cat calls post_message(targetCats: ['codex']) but it fails.
    // Before the fix, structuredTargetCats still had ['codex'] → hint suppressed.
    const opusService = createPostMessageService(
      'opus',
      'Sending review request.',
      ['codex'],
      '{"error":"delivery_failed"}',
      false,
    );
    const { appended, ballEvents } = await runA2ARoute(opusService);

    const hint = appended.find((m) => m.source?.connector === 'ack-liveness-hint');
    assert.ok(hint, 'failed post_message must NOT suppress ack-liveness-hint');

    const voidAck = ballEvents.find((e) => e.kind === 'ball.void_ack');
    assert.ok(voidAck, 'failed post_message must emit ball.void_ack');
  });

  test('successful post_message (confirmed) suppresses hint', async () => {
    // Cat calls post_message(targetCats: ['codex']) and it succeeds.
    const opusService = createPostMessageService(
      'opus',
      'Sending review request.',
      ['codex'],
      '{"status":"ok","messageId":"pm-1","threadId":"thr-pm"}',
      true,
    );
    const { appended, ballEvents } = await runA2ARoute(opusService);

    const hint = appended.find((m) => m.source?.connector === 'ack-liveness-hint');
    assert.equal(hint, undefined, 'successful post_message must suppress hint');

    const voidAck = ballEvents.find((e) => e.kind === 'ball.void_ack');
    assert.equal(voidAck, undefined, 'successful post_message must not emit void_ack');
  });
});
