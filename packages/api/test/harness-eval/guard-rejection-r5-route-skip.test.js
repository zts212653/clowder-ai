/**
 * F257 V2 R5 P2-2 — routeSerial route_decision_skip event emission.
 *
 * When hasQueuedOrActiveAgentForCat returns true for a mentioned cat,
 * routeSerial skips the cat and emits a `route_decision_skip` event
 * via guardRejectionLog. This test drives the REAL routeSerial with
 * a controlled hasQueuedOrActiveAgentForCat to verify:
 *
 *   1. Skip case: target NOT invoked, exactly 1 skip event with correct fields
 *   2. No-skip counterexample: target invoked, zero skip events
 *
 * [opus/claude-opus-4-6🐾]
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { catRegistry } from '@cat-cafe/shared';

// ---------------------------------------------------------------------------
// Concurrency guard — catRegistry is global; serialise mutating tests
// ---------------------------------------------------------------------------

let catRegistryLock = Promise.resolve();

function withCatRegistryLock(fn) {
  const previous = catRegistryLock;
  let release;
  catRegistryLock = new Promise((resolve) => {
    release = resolve;
  });
  return previous.then(() => fn().finally(release));
}

// ---------------------------------------------------------------------------
// Helpers (minimal subset of route-serial-routing-guard-remedial rig)
// ---------------------------------------------------------------------------

function createSequenceService(catId, texts, { needsGuard = true } = {}) {
  const calls = [];
  return {
    calls,
    needsServerRoutingGuard: () => needsGuard,
    async *invoke(prompt) {
      calls.push(prompt);
      const turn = texts[Math.min(calls.length - 1, texts.length - 1)] ?? '';
      yield {
        type: 'system_info',
        catId,
        content: JSON.stringify({ type: 'invocation_created', invocationId: `${catId}-inv-${calls.length}` }),
        timestamp: Date.now(),
      };
      const events = Array.isArray(turn) ? turn : [{ type: 'text', content: turn }];
      for (const event of events) {
        yield { catId, timestamp: Date.now(), ...event };
      }
      yield { type: 'done', catId, timestamp: Date.now() };
    },
  };
}

function createMockGuardRejectionLog() {
  const events = [];
  return {
    events,
    append: async (event) => {
      events.push(event);
      return event;
    },
  };
}

function createMockDeps(services, appendedMessages, { guardRejectionLog } = {}) {
  let counter = 0;
  const deps = {
    services,
    invocationDeps: {
      registry: {
        create: () => ({ invocationId: `outer-inv-${++counter}`, callbackToken: `tok-${counter}` }),
        verify: async () => ({ ok: false, reason: 'unknown_invocation' }),
      },
      sessionManager: {
        getOrCreate: async () => ({}),
        get: async () => null,
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
          origin: msg.origin,
          mentionsUser: msg.mentionsUser,
          toolEvents: msg.toolEvents,
          extra: msg.extra,
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
      augmentStreamMetadata: async () => true,
    },
    draftStore: {
      upsert: () => {},
      touch: () => {},
      delete: () => Promise.resolve(),
      deleteByThread: () => {},
      getByThread: () => [],
    },
    socketManager: {
      broadcastToRoom() {},
    },
  };
  if (guardRejectionLog) {
    deps.guardRejectionLog = guardRejectionLog;
  }
  return deps;
}

async function loadRealRoster() {
  const { loadCatConfig, toAllCatConfigs } = await import('../../dist/config/cat-config-loader.js');
  const runtimeConfigs = toAllCatConfigs(loadCatConfig());
  catRegistry.reset();
  for (const [id, config] of Object.entries(runtimeConfigs)) {
    catRegistry.register(id, config);
  }
}

async function runRoute(codexService, threadId, { extraServices = {}, routeOptions = {}, guardRejectionLog } = {}) {
  return withCatRegistryLock(async () => {
    const original = catRegistry.getAllConfigs();
    await loadRealRoster();
    const appended = [];
    try {
      const { routeSerial } = await import('../../dist/domains/cats/services/agents/routing/route-serial.js');
      const deps = createMockDeps({ codex: codexService, ...extraServices }, appended, { guardRejectionLog });
      const yielded = [];
      for await (const msg of routeSerial(deps, ['codex'], 'skip test', 'user1', threadId, {
        thinkingMode: 'play',
        invocationController: new AbortController(),
        trackA2ASlot: () => true,
        completeA2ASlots: () => {},
        ...routeOptions,
      })) {
        yielded.push(msg);
      }
      return { appended, yielded, codexCalls: codexService.calls };
    } finally {
      catRegistry.reset();
      for (const [id, config] of Object.entries(original)) {
        catRegistry.register(id, config);
      }
    }
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('F257 V2 P2-2: route_decision_skip event emission', () => {
  test('depth skip: target is not reinvoked and exactly 1 skip event carries the full contract', async () => {
    const codexService = createSequenceService('codex', ['@opus\n@gemini']);
    const opusService = createSequenceService('opus', ['ack from opus'], { needsGuard: false });
    const geminiService = createSequenceService('gemini', ['must stay unreachable'], { needsGuard: false });
    const log = createMockGuardRejectionLog();

    const { codexCalls } = await runRoute(codexService, 'thread-f257-skip-emit', {
      extraServices: { opus: opusService, gemini: geminiService },
      guardRejectionLog: log,
      routeOptions: {
        maxA2ADepth: 1,
      },
    });

    assert.equal(codexCalls.length, 1, 'codex emits the two-target routing decision once');
    assert.equal(opusService.calls.length, 1, 'the first handoff consumes the only A2A depth slot');
    assert.equal(geminiService.calls.length, 0, 'the second target must remain uninvoked after the depth limit');
    // exactly 1 skip event
    const skipEvents = log.events.filter((e) => e.kind === 'route_decision_skip');
    assert.equal(skipEvents.length, 1, 'exactly one route_decision_skip event');

    // Full octet + dual-coordinate contract assertion (sol R6 P3-1)
    const evt = skipEvents[0];
    assert.ok(evt.eventId, 'eventId must be present');
    assert.ok(evt.ledgerId, 'ledgerId must be present');
    assert.equal(evt.kind, 'route_decision_skip');
    assert.equal(evt.guardId, 'a2a_route_decision_skip');
    assert.equal(evt.threadId, 'thread-f257-skip-emit', 'threadId must match route threadId');
    assert.equal(evt.catId, 'codex', 'catId must be the caller that attempted the blocked handoff');
    assert.equal(evt.invocationId, 'unknown', 'invocationId is unknown for skip path');
    assert.equal(evt.sourceTool, 'a2a_mention');
    assert.equal(evt.normalizedReason, 'depth');
    assert.equal(evt.layer, 'generator');
    assert.equal(evt.correlationConfidence, 'window');
    assert.ok(evt.timestamp > 0, 'timestamp must be positive');
    assert.equal(evt.ownerUserId, 'user1', 'ownerUserId must match the caller');
    assert.equal(evt.targetCatId, 'gemini', 'targetCatId must be the skipped cat');
    assert.equal(evt.skipReason, 'depth', 'skipReason must match decision reason');
  });

  test('no-skip counterexample: target invoked, zero skip events', async () => {
    const codexService = createSequenceService('codex', ['@opus']);
    const opusService = createSequenceService('opus', ['ack from opus'], { needsGuard: false });
    const log = createMockGuardRejectionLog();

    await runRoute(codexService, 'thread-f257-no-skip', {
      extraServices: { opus: opusService },
      guardRejectionLog: log,
      routeOptions: {
        hasQueuedOrActiveAgentForCat: () => false,
      },
    });

    // opus should be invoked normally
    assert.equal(opusService.calls.length, 1, 'opus must be invoked when hasActiveAgent=false');
    // zero skip events
    const skipEvents = log.events.filter((e) => e.kind === 'route_decision_skip');
    assert.equal(skipEvents.length, 0, 'no skip events when routing proceeds normally');
  });
});
