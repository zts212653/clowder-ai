/**
 * F215: Malformed Tool-Call Recovery — TDD red/green tests
 *
 * Tests cover:
 *  - AC-B1: textEventCount===0 + no valid tool_use block → malformed detected
 *  - AC-B3: textEventCount>0 → NOT malformed (regression guard)
 *  - AC-B3 (pure tool_use): textEventCount===0 but content has tool_use → NOT malformed
 *
 * Fixture: d137d9eb-c53f-4f18-90d6-822c784df8f5.ndjson (opus-4-8 thinking-only, form A)
 * The fixture result event is subtype:success with result:'' — textEventCount stays 0.
 *
 * Phase C fallback chain:
 *  - AC-C1: malformed triggers seal (system_info malformed_toolcall_detected emitted)
 *  - AC-C2: fresh-context retry (sessionId=undefined)
 *  - AC-C3: if fresh retry also malformed → system card + note about 46 接力
 *
 * Phase D:
 *  - AC-D1: final failure has explicit炸毛 error message
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { ensureFakeCliOnPath } from './helpers/fake-cli-path.js';
import {
  buildFakeL0Compiler,
  createMockArchive,
  createMockProcess,
  createMockSpawnFn,
  emitEvents,
} from './helpers/provider-archive-test-helpers.js';

ensureFakeCliOnPath('claude');

const { ClaudeAgentService } = await import('../dist/domains/cats/services/agents/providers/ClaudeAgentService.js');

// ── Helper: build a minimal thinking-only assistant event (form A fixture) ──

function makeThinkingOnlyAssistantEvent(sessionId = 'ses-form-a') {
  return {
    type: 'assistant',
    message: {
      model: 'claude-opus-4-8',
      id: 'msg_formA',
      type: 'message',
      role: 'assistant',
      content: [
        {
          type: 'thinking',
          thinking: 'I need to use a tool here...',
          signature: 'EoSFAQ...',
        },
      ],
      stop_reason: 'end_turn',
    },
    session_id: sessionId,
  };
}

// Simulate --include-partial-messages streaming: text_delta arrives before final assistant event.
// The assistant event with the same messageId will have its text skipped by transformClaudeEvent
// (skipFinalText=true, because partialTextMessageIds already has the messageId).
function makeStreamEventMessageStart(messageId = 'msg_stream') {
  return {
    type: 'stream_event',
    event: {
      type: 'message_start',
      message: { id: messageId, type: 'message', role: 'assistant' },
    },
  };
}

function makeStreamEventTextDelta(text, messageId = 'msg_stream') {
  return {
    type: 'stream_event',
    event: {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text },
    },
  };
}

function makeAssistantWithTextStreamed(messageId = 'msg_stream', sessionId = 'ses-stream') {
  return {
    type: 'assistant',
    message: {
      model: 'claude-opus-4-8',
      id: messageId, // matches stream_event.message_start → transformClaudeEvent will skipFinalText
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: 'Hello streaming world' }],
      stop_reason: 'end_turn',
    },
    session_id: sessionId,
  };
}

function makeAssistantWithToolUse(sessionId = 'ses-tool-use') {
  return {
    type: 'assistant',
    message: {
      model: 'claude-opus-4-8',
      id: 'msg_tooluse',
      type: 'message',
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          id: 'toolu_123',
          name: 'Bash',
          input: { command: 'ls' },
        },
      ],
      stop_reason: 'tool_use',
    },
    session_id: sessionId,
  };
}

function makeAssistantWithText(sessionId = 'ses-text') {
  return {
    type: 'assistant',
    message: {
      model: 'claude-opus-4-8',
      id: 'msg_text',
      type: 'message',
      role: 'assistant',
      content: [
        {
          type: 'text',
          text: 'Hello, I can help you with that.',
        },
      ],
      stop_reason: 'end_turn',
    },
    session_id: sessionId,
  };
}

// ── AC-B1: form A detection (thinking-only → malformed) ──

describe('F215 AC-B1: malformed detection (form A thinking-only)', () => {
  test('emits malformed_toolcall_detected system_info when textEventCount===0 and no tool_use', async () => {
    const proc = createMockProcess();
    const spawnFn = createMockSpawnFn(proc);
    const rawArchive = createMockArchive();
    const service = new ClaudeAgentService({
      spawnFn,
      model: 'claude-opus-4-8',
      l0CompilerFn: buildFakeL0Compiler(),
      rawArchive,
    });

    const msgs = [];
    const promise = (async () => {
      for await (const msg of service.invoke('test malformed detection', {
        invocationId: 'inv-malformed-1',
        sessionId: 'ses-thinking-only',
      })) {
        msgs.push(msg);
      }
    })();

    // Emit: system/init → thinking-only assistant → result/success
    emitEvents(proc, [
      { type: 'system', subtype: 'init', session_id: 'ses-thinking-only' },
      makeThinkingOnlyAssistantEvent('ses-thinking-only'),
      { type: 'result', subtype: 'success', result: '' },
    ]);

    await promise;

    const malformedSignal = msgs.find(
      (m) =>
        m.type === 'system_info' &&
        (() => {
          try {
            const parsed = JSON.parse(m.content ?? '{}');
            return parsed.type === 'malformed_toolcall_detected';
          } catch {
            return false;
          }
        })(),
    );
    assert.ok(
      malformedSignal,
      `Expected malformed_toolcall_detected system_info event. Got types: ${msgs.map((m) => m.type).join(',')}`,
    );
  });

  test('emits an error message indicating malformed tool call when textEventCount===0 and no tool_use', async () => {
    const proc = createMockProcess();
    const spawnFn = createMockSpawnFn(proc);
    const service = new ClaudeAgentService({
      spawnFn,
      model: 'claude-opus-4-8',
      l0CompilerFn: buildFakeL0Compiler(),
      rawArchive: createMockArchive(),
    });

    const msgs = [];
    const promise = (async () => {
      for await (const msg of service.invoke('malformed error test', {
        invocationId: 'inv-malformed-err',
        sessionId: 'ses-thinking-only-2',
      })) {
        msgs.push(msg);
      }
    })();

    emitEvents(proc, [
      { type: 'system', subtype: 'init', session_id: 'ses-thinking-only-2' },
      makeThinkingOnlyAssistantEvent('ses-thinking-only-2'),
      { type: 'result', subtype: 'success', result: '' },
    ]);

    await promise;

    const errorMsg = msgs.find(
      (m) => m.type === 'error' && typeof m.error === 'string' && m.error.includes('malformed_toolcall'),
    );
    assert.ok(
      errorMsg,
      `Expected error message containing 'malformed_toolcall'. Messages: ${JSON.stringify(msgs.map((m) => ({ type: m.type, error: m.error })))}`,
    );
  });
});

// ── AC-B3 regression: textEventCount>0 → NOT malformed ──

describe('F215 AC-B3: regression guard — normal text completion not malformed', () => {
  test('does NOT emit malformed_toolcall_detected when textEventCount>0', async () => {
    const proc = createMockProcess();
    const spawnFn = createMockSpawnFn(proc);
    const service = new ClaudeAgentService({
      spawnFn,
      model: 'claude-opus-4-8',
      l0CompilerFn: buildFakeL0Compiler(),
      rawArchive: createMockArchive(),
    });

    const msgs = [];
    const promise = (async () => {
      for await (const msg of service.invoke('normal text test')) {
        msgs.push(msg);
      }
    })();

    emitEvents(proc, [
      { type: 'system', subtype: 'init', session_id: 'ses-normal-text' },
      makeAssistantWithText('ses-normal-text'),
      { type: 'result', subtype: 'success' },
    ]);

    await promise;

    const malformedSignal = msgs.find(
      (m) =>
        m.type === 'system_info' &&
        (() => {
          try {
            const parsed = JSON.parse(m.content ?? '{}');
            return parsed.type === 'malformed_toolcall_detected';
          } catch {
            return false;
          }
        })(),
    );
    assert.equal(malformedSignal, undefined, 'Should NOT emit malformed_toolcall_detected for normal text response');
  });
});

// ── AC-B3 (pure tool_use): textEventCount===0 + has tool_use block → NOT malformed ──

describe('F215 AC-B3: pure tool_use invocation not falsely malformed', () => {
  test('does NOT emit malformed_toolcall_detected when textEventCount===0 but content has valid tool_use', async () => {
    const proc = createMockProcess();
    const spawnFn = createMockSpawnFn(proc);
    const service = new ClaudeAgentService({
      spawnFn,
      model: 'claude-opus-4-8',
      l0CompilerFn: buildFakeL0Compiler(),
      rawArchive: createMockArchive(),
    });

    const msgs = [];
    const promise = (async () => {
      for await (const msg of service.invoke('pure tool use test')) {
        msgs.push(msg);
      }
    })();

    emitEvents(proc, [
      { type: 'system', subtype: 'init', session_id: 'ses-tool-use' },
      makeAssistantWithToolUse('ses-tool-use'),
      { type: 'result', subtype: 'success' },
    ]);

    await promise;

    const malformedSignal = msgs.find(
      (m) =>
        m.type === 'system_info' &&
        (() => {
          try {
            const parsed = JSON.parse(m.content ?? '{}');
            return parsed.type === 'malformed_toolcall_detected';
          } catch {
            return false;
          }
        })(),
    );
    assert.equal(
      malformedSignal,
      undefined,
      'Should NOT emit malformed_toolcall_detected when content has valid tool_use block',
    );
  });
});

// ── AC-B5 (P1 fix): streaming mode — text_delta before assistant must NOT cause false malformed ──
//
// Scenario: --include-partial-messages mode.
// text_delta arrives BEFORE the final assistant event (transformClaudeEvent increments textEventsSinceLastAssistant).
// Then assistant event resets textEventsSinceLastAssistant=0 (old code bug).
// transformClaudeEvent: skipFinalText=true → text block in content is skipped → no new text event.
// End-of-invocation check: textEventsSinceLastAssistant===0 → WRONGLY emits malformed_toolcall.
//
// Fixed code: check lastAssistantHasTextBlock (content blocks), not textEventsSinceLastAssistant.
// The assistant content block has text → lastAssistantHasTextBlock=true → NOT malformed.

describe('F215 AC-B5 (P1 fix): streaming mode — text before assistant event not falsely malformed', () => {
  test('does NOT emit malformed when streaming text_delta precedes the final assistant event', async () => {
    const proc = createMockProcess();
    const spawnFn = createMockSpawnFn(proc);
    const service = new ClaudeAgentService({
      spawnFn,
      model: 'claude-opus-4-8',
      l0CompilerFn: buildFakeL0Compiler(),
      rawArchive: createMockArchive(),
    });

    const msgs = [];
    const promise = (async () => {
      for await (const msg of service.invoke('streaming text test', {
        invocationId: 'inv-streaming-text',
        sessionId: 'ses-streaming-text',
      })) {
        msgs.push(msg);
      }
    })();

    const MSG_ID = 'msg-streaming-s1';

    // Streaming mode: message_start → text_delta (text event, textEventsSinceLastAssistant++) →
    // assistant event (content has text block; transformClaudeEvent skipFinalText=true → NO new text events,
    // OLD code resets textEventsSinceLastAssistant=0 → false malformed!)
    emitEvents(proc, [
      { type: 'system', subtype: 'init', session_id: 'ses-streaming-text' },
      makeStreamEventMessageStart(MSG_ID), // starts message_start tracking
      makeStreamEventTextDelta('Hello streaming!', MSG_ID), // text_delta → text event
      makeAssistantWithTextStreamed(MSG_ID, 'ses-streaming-text'), // final assistant, skipFinalText=true
      { type: 'result', subtype: 'success' },
    ]);

    await promise;

    const malformedSignal = msgs.find(
      (m) =>
        m.type === 'system_info' &&
        (() => {
          try {
            const parsed = JSON.parse(m.content ?? '{}');
            return parsed.type === 'malformed_toolcall_detected';
          } catch {
            return false;
          }
        })(),
    );
    assert.equal(
      malformedSignal,
      undefined,
      `Should NOT emit malformed_toolcall_detected for streaming text response. Got: ${msgs.map((m) => m.type).join(',')}`,
    );
  });
});

// ── AC-B4 (P1 fix): multi-turn — earlier tool_use turn must NOT suppress detection ──
//
// Scenario: Turn 1 has tool_use (sets hasToolUseBlock=true in naive global tracking).
// Turn 2 is thinking-only malformed. Old code: hasToolUseBlock=true → condition fails → leaks silently.
// Fixed code: per-last-assistant tracking → last turn has no tool_use → detected correctly.

describe('F215 AC-B4 (P1 fix): multi-turn thinking-only malformed after tool_use turn', () => {
  test('detects malformed when last assistant turn is thinking-only, even if earlier turn had tool_use', async () => {
    const proc = createMockProcess();
    const spawnFn = createMockSpawnFn(proc);
    const service = new ClaudeAgentService({
      spawnFn,
      model: 'claude-opus-4-8',
      l0CompilerFn: buildFakeL0Compiler(),
      rawArchive: createMockArchive(),
    });

    const msgs = [];
    const promise = (async () => {
      for await (const msg of service.invoke('multi-turn malformed test', {
        invocationId: 'inv-multi-turn-malformed',
        sessionId: 'ses-multi-turn-malformed',
      })) {
        msgs.push(msg);
      }
    })();

    // Turn 1: valid tool_use (would set hasToolUseBlock=true in old global tracking)
    // Turn 2: thinking-only malformed (should STILL be detected — per-last-turn tracking)
    emitEvents(proc, [
      { type: 'system', subtype: 'init', session_id: 'ses-multi-turn-malformed' },
      makeAssistantWithToolUse('ses-multi-turn-malformed'), // Turn 1: tool_use
      makeThinkingOnlyAssistantEvent('ses-multi-turn-malformed'), // Turn 2: malformed
      { type: 'result', subtype: 'success', result: '' },
    ]);

    await promise;

    const malformedSignal = msgs.find(
      (m) =>
        m.type === 'system_info' &&
        (() => {
          try {
            const parsed = JSON.parse(m.content ?? '{}');
            return parsed.type === 'malformed_toolcall_detected';
          } catch {
            return false;
          }
        })(),
    );
    assert.ok(
      malformedSignal,
      `Expected malformed_toolcall_detected even when earlier turn had tool_use. Got types: ${msgs.map((m) => m.type).join(',')}`,
    );
  });
});

// ── AC-D1: final failure has explicit 炸毛 error message ──

describe('F215 AC-D1: final failure has explicit error message', () => {
  test('malformed invocation always yields a done message (not silent empty return)', async () => {
    const proc = createMockProcess();
    const spawnFn = createMockSpawnFn(proc);
    const service = new ClaudeAgentService({
      spawnFn,
      model: 'claude-opus-4-8',
      l0CompilerFn: buildFakeL0Compiler(),
      rawArchive: createMockArchive(),
    });

    const msgs = [];
    const promise = (async () => {
      for await (const msg of service.invoke('final failure test', {
        invocationId: 'inv-final-fail',
        sessionId: 'ses-malformed-final',
      })) {
        msgs.push(msg);
      }
    })();

    emitEvents(proc, [
      { type: 'system', subtype: 'init', session_id: 'ses-malformed-final' },
      makeThinkingOnlyAssistantEvent('ses-malformed-final'),
      { type: 'result', subtype: 'success', result: '' },
    ]);

    await promise;

    // Verify done is emitted (not silent empty return)
    const doneMsg = msgs.find((m) => m.type === 'done');
    assert.ok(doneMsg, 'done message must always be emitted');

    // Verify there is both an error message AND a malformed signal (not silent)
    const errorMsg = msgs.find((m) => m.type === 'error');
    assert.ok(errorMsg, 'error message must be emitted for malformed invocation (AC-D1: not silent)');
  });
});

// ── AC-C3: route-serial layer — malformed relay pushes opus-4.6 to worklist ──

// Minimal routeSerial deps (mirrors f046-b5-runtime-regression-seed.test.js pattern)
function createMalformedRelayDeps(services) {
  let counter = 0;
  return {
    services,
    invocationDeps: {
      registry: {
        create: () => ({ invocationId: `inv-${++counter}`, callbackToken: `tok-${counter}` }),
        verify: async () => ({ ok: false, reason: 'unknown_invocation' }),
      },
      sessionManager: {
        getOrCreate: async () => ({}),
        resolveWorkingDirectory: () => '/tmp/test',
      },
      threadStore: null,
      apiUrl: 'http://127.0.0.1:3004',
    },
    messageStore: {
      append: async () => ({
        id: `msg-${counter}`,
        userId: '',
        catId: null,
        content: '',
        mentions: [],
        timestamp: 0,
      }),
      getById: () => null,
      getRecent: () => [],
      getMentionsFor: () => [],
      getBefore: () => [],
      getByThread: () => [],
      getByThreadAfter: () => [],
      getByThreadBefore: () => [],
    },
  };
}

// Service that emits the malformed_toolcall_relay_46 signal + error (simulates
// invokeSingleCat AC-C3 output when all retries are exhausted)
function createMalformedOpusService(catId) {
  return {
    async *invoke(_prompt, _opts) {
      // Simulate invocation_created first so ownInvocationId is set
      yield {
        type: 'system_info',
        catId,
        content: JSON.stringify({ type: 'invocation_created', invocationId: 'inv-malformed-48' }),
        timestamp: Date.now(),
      };
      // The relay card (AC-C3)
      yield {
        type: 'system_info',
        catId,
        content: JSON.stringify({
          type: 'malformed_toolcall_relay_46',
          card: '🙀 Opus 4.8 炸毛了',
          invocationId: 'inv-malformed-48',
        }),
        timestamp: Date.now(),
      };
      // The suppressed error (AC-C3: route-serial should swallow this)
      yield {
        type: 'error',
        catId,
        error: 'malformed_toolcall: Opus 4.8 炸毛，fresh-context 重试仍失败。请重试，系统将用 Opus 4.6 接班（AC-D1）',
        timestamp: Date.now(),
      };
      yield { type: 'done', catId, timestamp: Date.now() };
    },
  };
}

// Service for opus-4.6 that produces normal output
function createRelay46Service(catId = 'opus') {
  const calls = [];
  const service = {
    calls,
    async *invoke(prompt, _opts) {
      calls.push(prompt);
      yield { type: 'text', catId, content: '我是 opus-4.6，接力完成任务。', timestamp: Date.now() };
      yield { type: 'done', catId, timestamp: Date.now() };
    },
  };
  return service;
}

describe('F215 AC-C3: route-serial malformed relay pushes opus-4.6 to worklist', () => {
  test('when opus48 炸毛, opus-4.6 is invoked as relay and user sees no malformed error', async () => {
    const { routeSerial } = await import('../dist/domains/cats/services/agents/routing/route-serial.js');

    // opus48 = the cat that炸毛; opus = the 46 relay
    const opus48CatId = 'opus48';
    const relay46Service = createRelay46Service('opus');
    const deps = createMalformedRelayDeps({
      [opus48CatId]: createMalformedOpusService(opus48CatId),
      opus: relay46Service,
    });

    const allMsgs = [];
    for await (const msg of routeSerial(
      deps,
      [opus48CatId],
      'complete my task',
      'user-test',
      'thread-relay-test',
      {},
    )) {
      allMsgs.push(msg);
    }

    // 1. opus-4.6 must have been invoked (relay happened)
    assert.equal(relay46Service.calls.length, 1, 'opus-4.6 should be invoked as relay');

    // 2. User must see text output from opus-4.6
    const relayText = allMsgs.find((m) => m.type === 'text' && m.catId === 'opus');
    assert.ok(relayText, 'relay46 text output must reach user');
    assert.ok(relayText.content.includes('opus-4.6'), 'relay text should identify 4.6');

    // 3. malformed error must NOT be surfaced to user
    const malformedErrors = allMsgs.filter(
      (m) => m.type === 'error' && typeof m.error === 'string' && m.error.startsWith('malformed_toolcall:'),
    );
    assert.equal(malformedErrors.length, 0, 'malformed_toolcall error must be suppressed by relay');

    // 4. routing signal must NOT leak to frontend (砚砚 re-review: route-serial must consume+drop it)
    const leakedRouteSignals = allMsgs.filter((m) => {
      try {
        return m.type === 'system_info' && JSON.parse(m.content ?? '{}').type === 'malformed_toolcall_relay_46';
      } catch {
        return false;
      }
    });
    assert.equal(leakedRouteSignals.length, 0, 'malformed_toolcall_relay_46 routing signal must not leak to user');
  });

  test('does NOT push duplicate relay cat when opus is already pending in worklist', async () => {
    // P2 fix: if worklist already contains opus (e.g. user routed to [opus48, opus]),
    // the relay push must be skipped — opus must be invoked exactly ONCE.
    const { routeSerial } = await import('../dist/domains/cats/services/agents/routing/route-serial.js');
    const opus48CatId = 'opus48';
    const relay46Service = createRelay46Service('opus');
    const deps = createMalformedRelayDeps({
      [opus48CatId]: createMalformedOpusService(opus48CatId),
      opus: relay46Service,
    });

    const allMsgs = [];
    for await (const msg of routeSerial(
      deps,
      [opus48CatId, 'opus'], // opus already in worklist — must NOT be pushed again
      'complete my task',
      'user-test',
      'thread-dup-relay',
      {},
    )) {
      allMsgs.push(msg);
    }

    // opus must be called exactly ONCE — either from original slot or relay, never both
    assert.equal(
      relay46Service.calls.length,
      1,
      'opus must be invoked exactly once, not twice (P2: no duplicate relay push)',
    );
  });

  test('DOES relay when opus already ran earlier in the route (executed vs pending check)', async () => {
    // P1 #1 fix: duplicate guard must check PENDING entries only, not the full worklist.
    // Scenario: [opus, opus-48] — opus runs first (executed), then opus-48 炸毛.
    // relay SHOULD push opus again (executed ≠ pending duplicate).
    // Old bug: worklist.includes(opus) = true even for executed opus → relay silently skipped.
    const { routeSerial } = await import('../dist/domains/cats/services/agents/routing/route-serial.js');

    // First slot: normal opus service (runs first, index=0)
    const normalOpusService = createRelay46Service('opus'); // produces normal relay output
    const opus48CatId = 'opus48';
    const deps = createMalformedRelayDeps({
      opus: normalOpusService, // opus runs FIRST as worklist[0]
      [opus48CatId]: createMalformedOpusService(opus48CatId), // opus-48 炸毛 as worklist[1]
    });

    const allMsgs = [];
    for await (const msg of routeSerial(
      deps,
      ['opus', opus48CatId], // opus executes first, then opus-48 炸毛
      'complete my task',
      'user-test',
      'thread-executed-relay',
      {},
    )) {
      allMsgs.push(msg);
    }

    // opus must be invoked TWICE: once from the original worklist slot, once from relay
    // (executed opus ≠ pending duplicate — relay push is correct here)
    assert.equal(
      normalOpusService.calls.length,
      2,
      'opus must be invoked twice: once from worklist and once as malformed relay (P1: executed ≠ pending)',
    );
  });

  test('does NOT relay when opus-4.6 service is not available', async () => {
    const { routeSerial } = await import('../dist/domains/cats/services/agents/routing/route-serial.js');

    // Only opus48 service, no opus service
    const opus48CatId = 'opus48';
    const deps = createMalformedRelayDeps({
      [opus48CatId]: createMalformedOpusService(opus48CatId),
      // intentionally no 'opus' service
    });

    const allMsgs = [];
    for await (const msg of routeSerial(deps, [opus48CatId], 'complete my task', 'user-test', 'thread-no-relay', {})) {
      allMsgs.push(msg);
    }

    // The error should be surfaced since no relay is possible
    const malformedErrors = allMsgs.filter(
      (m) => m.type === 'error' && typeof m.error === 'string' && m.error.startsWith('malformed_toolcall:'),
    );
    assert.equal(malformedErrors.length, 1, 'malformed error must reach user when no relay service is available');
  });
});

// ── BLOCKING 3: invokeSingleCat end-to-end (真实链，不是 mock routeSerial) ──
// Verifies the full invokeSingleCat chain: service emits malformed signals → invokeSingleCat
// suppresses the detection signal (BLOCKING 2 fix) → seals → retries → emits relay_46 signal
// + user-visible text card (BLOCKING 1 fix) → no "请重新发送请求" (BLOCKING 4 fix).
//
// We mock the AgentService at the service boundary (same level as ClaudeAgentService output)
// so both the initial attempt and the fresh-context retry produce the malformed signal/error pair.
// This tests invokeSingleCat's suppression and relay logic directly, independent of routeSerial.

describe('F215 BLOCKING-3: invokeSingleCat E2E — malformed service → suppress → retry → relay signal', () => {
  test('malformed service x2 → relay signal emitted, malformed_toolcall_detected NOT leaked', async () => {
    const { invokeSingleCat } = await import('../dist/domains/cats/services/agents/invocation/invoke-single-cat.js');

    // Mock service that produces what ClaudeAgentService emits on a form-A malformed invocation:
    // 1. system_info (malformed_toolcall_detected) — emitted by ClaudeAgentService on detection
    // 2. error (malformed_toolcall: ...) — the typed error triggering the retry in invokeSingleCat
    // 3. done — end of iteration
    // Both the first call and the retry produce this output so all maxAttempts exhaust.
    const malformedService = {
      async *invoke(_prompt, _opts) {
        yield {
          type: 'system_info',
          catId: 'opus48',
          content: JSON.stringify({ type: 'malformed_toolcall_detected', sessionId: 'ses-e2e' }),
          timestamp: Date.now(),
        };
        yield {
          type: 'error',
          catId: 'opus48',
          error: 'malformed_toolcall: Opus 炸毛了——thinking-only 输出，无 tool_use / text block',
          timestamp: Date.now(),
        };
        yield { type: 'done', catId: 'opus48', timestamp: Date.now() };
      },
    };

    // Minimal deps: no sessionSealer/sessionChainStore (seal is best-effort, skip for unit test)
    let regCounter = 0;
    const deps = {
      registry: {
        create: async () => ({ invocationId: `inv-e2e-${++regCounter}`, callbackToken: `tok-${regCounter}` }),
        verify: async () => ({ ok: false, reason: 'unknown_invocation' }),
      },
      sessionManager: {
        get: async () => undefined,
        getOrCreate: async () => ({}),
        store: async () => {},
        delete: async () => {},
        resolveWorkingDirectory: () => '/tmp/test',
      },
      threadStore: null,
      apiUrl: 'http://127.0.0.1:3004',
    };

    const msgs = [];
    for await (const msg of invokeSingleCat(deps, {
      catId: 'opus48',
      service: malformedService,
      prompt: 'test e2e malformed chain',
      userId: 'user-e2e',
      threadId: 'thread-e2e',
      isLastCat: true,
    })) {
      msgs.push(msg);
    }

    // Key assertion 1: relay signal emitted (proves invokeSingleCat seal→retry→exhausted chain ran)
    const relaySignal = msgs.find((m) => {
      try {
        return m.type === 'system_info' && JSON.parse(m.content ?? '{}').type === 'malformed_toolcall_relay_46';
      } catch {
        return false;
      }
    });
    assert.ok(
      relaySignal,
      `Expected malformed_toolcall_relay_46 signal. Got: ${msgs.map((m) => `${m.type}:${m.content ?? m.error ?? ''}`).join(', ')}`,
    );

    // Key assertion 2: user-visible relay card (text type) emitted before signal (BLOCKING 1 fix)
    const relayCardText = msgs.find(
      (m) => m.type === 'text' && typeof m.content === 'string' && m.content.includes('Opus 4.8 炸毛了'),
    );
    assert.ok(relayCardText, 'Expected user-visible relay card as text message (BLOCKING 1 fix)');

    // Key assertion 3: malformed_toolcall_detected MUST NOT leak to caller (BLOCKING 2 fix)
    const detectedLeaks = msgs.filter((m) => {
      try {
        return m.type === 'system_info' && JSON.parse(m.content ?? '{}').type === 'malformed_toolcall_detected';
      } catch {
        return false;
      }
    });
    assert.equal(
      detectedLeaks.length,
      0,
      `malformed_toolcall_detected must NOT leak to caller. Got ${detectedLeaks.length} leaks`,
    );

    // Key assertion 4: relay card text must NOT contain "请重新发送请求" (BLOCKING 4 fix)
    if (relayCardText) {
      assert.ok(
        !relayCardText.content.includes('请重新发送请求'),
        'Relay card must not say "请重新发送请求" — relay is automatic, task不丢',
      );
    }
  });

  test('invokeSingleCat final malformed fallback always emits done so callers are not left hanging', async () => {
    // P1 #2 fix: provider done is consumed by the suppression path (continue); the final fallback
    // emits card/signal/error then breaks. Without an explicit done, route-serial's doneMsg stays
    // null and direct invokeSingleCat consumers never receive the terminal done/isFinal signal.
    const { invokeSingleCat } = await import('../dist/domains/cats/services/agents/invocation/invoke-single-cat.js');
    const malformedService = {
      async *invoke(_prompt, _opts) {
        yield {
          type: 'system_info',
          catId: 'opus48',
          content: JSON.stringify({ type: 'malformed_toolcall_detected', sessionId: 'ses-done-test' }),
          timestamp: Date.now(),
        };
        yield {
          type: 'error',
          catId: 'opus48',
          error: 'malformed_toolcall: thinking-only',
          timestamp: Date.now(),
        };
        yield { type: 'done', catId: 'opus48', timestamp: Date.now() };
      },
    };
    // Same minimal deps structure as BLOCKING-3 test
    let regCounterDone = 0;
    const depsForDoneTest = {
      registry: {
        create: async () => ({
          invocationId: `inv-done-${++regCounterDone}`,
          callbackToken: `tok-done-${regCounterDone}`,
        }),
        verify: async () => ({ ok: false, reason: 'unknown_invocation' }),
      },
      sessionManager: {
        get: async () => undefined,
        getOrCreate: async () => ({}),
        store: async () => {},
        delete: async () => {},
        resolveWorkingDirectory: () => '/tmp/test',
      },
      threadStore: null,
      apiUrl: 'http://127.0.0.1:3004',
    };

    const msgs = [];
    for await (const msg of invokeSingleCat(depsForDoneTest, {
      catId: 'opus48',
      service: malformedService,
      prompt: 'test done after final fallback',
      userId: 'user-done-test',
      threadId: 'thread-done-test',
      isLastCat: true,
    })) {
      msgs.push(msg);
    }

    const doneMsg = msgs.find((m) => m.type === 'done');
    assert.ok(
      doneMsg,
      'invokeSingleCat must emit done even after final malformed fallback (P1 #2: callers must not hang)',
    );
  });
});

// ── AC-B6 (P1 7th): malformed after content output → honest notice, no retry ──
//
// When Claude has already emitted text/tool_use output and then the final assistant turn is
// malformed (thinking-only), retrying would re-run the original prompt from scratch — duplicating
// tool actions and user-visible content. Instead: suppress the raw "malformed_toolcall:" error
// and yield an honest partial-output text notice ("手抖了...").
// Other self-heal paths (prompt limit, context overflow) all guard on !attemptHasContentOutput.
// F215 malformed must do the same, and additionally replace the misleading error with a notice.

describe('F215 AC-B6 (P1 7th): malformed after content output → honest notice, no retry', () => {
  test('raw malformed error replaced with partial-output notice when attemptHasContentOutput=true', async () => {
    // Tests at invokeSingleCat level (not ClaudeAgentService) because the guard is in invokeSingleCat.
    // Mock service: emits text (content output), then malformed detected + error + done.
    // Expected: raw "malformed_toolcall:" error is suppressed + replaced with honest text notice.
    // No retry fires (would duplicate tool actions).
    const { invokeSingleCat } = await import('../dist/domains/cats/services/agents/invocation/invoke-single-cat.js');

    const contentThenMalformedService = {
      async *invoke(_prompt, _opts) {
        // First: emit text (sets attemptHasContentOutput=true)
        yield { type: 'text', catId: 'opus48', content: 'I ran a tool and got results.', timestamp: Date.now() };
        // Then: malformed detected + error (what ClaudeAgentService emits on form-A malformed)
        yield {
          type: 'system_info',
          catId: 'opus48',
          content: JSON.stringify({ type: 'malformed_toolcall_detected', sessionId: 'ses-content-mal' }),
          timestamp: Date.now(),
        };
        yield {
          type: 'error',
          catId: 'opus48',
          error: 'malformed_toolcall: thinking-only after content output',
          timestamp: Date.now(),
        };
        yield { type: 'done', catId: 'opus48', timestamp: Date.now() };
      },
    };
    let regCounterB6 = 0;
    const depsB6 = {
      registry: {
        create: async () => ({ invocationId: `inv-b6-${++regCounterB6}`, callbackToken: `tok-b6-${regCounterB6}` }),
        verify: async () => ({ ok: false, reason: 'unknown_invocation' }),
      },
      sessionManager: {
        get: async () => undefined,
        getOrCreate: async () => ({}),
        store: async () => {},
        delete: async () => {},
        resolveWorkingDirectory: () => '/tmp/test',
      },
      threadStore: null,
      apiUrl: 'http://127.0.0.1:3004',
    };

    let invokeCount = 0;
    const trackingService = {
      async *invoke(_prompt, _opts) {
        invokeCount++;
        yield* contentThenMalformedService.invoke(_prompt, _opts);
      },
    };

    const msgs = [];
    for await (const msg of invokeSingleCat(depsB6, {
      catId: 'opus48',
      service: trackingService,
      prompt: 'content then malformed test',
      userId: 'user-b6',
      threadId: 'thread-b6',
      isLastCat: true,
    })) {
      msgs.push(msg);
    }

    // When content was already emitted, malformed error must NOT trigger a retry
    // (re-running the prompt would duplicate tool actions).
    // Guard: !attemptHasContentOutput — same as other self-heal paths.
    // Current bug: NO guard → service is called twice (retry happens despite content output).
    assert.equal(
      invokeCount,
      1,
      `service must be called exactly once when content output was emitted — no retry (P1: prevent duplicate tool actions). Was called: ${invokeCount}`,
    );

    // AC-B6 UX fix (砚砚 2026-05-30): raw "系统已触发恢复流程" error must NOT reach user.
    // When content was already emitted, the system does NOT retry — so saying "已触发恢复流程"
    // is a lie. The raw malformed error must be suppressed and replaced with an honest
    // partial-output notice (text type).
    const misleadingError = msgs.find(
      (m) => m.type === 'error' && typeof m.error === 'string' && m.error.startsWith('malformed_toolcall:'),
    );
    assert.equal(
      misleadingError,
      undefined,
      `raw malformed_toolcall: error must NOT reach user when content was already emitted. Got: ${JSON.stringify(misleadingError)}`,
    );

    // A honest partial-output notice (text type) must be emitted instead.
    const partialOutputNotice = msgs.find(
      (m) =>
        m.type === 'text' &&
        typeof m.content === 'string' &&
        m.content.includes('手抖') &&
        !m.content.includes('系统已触发恢复流程'),
    );
    assert.ok(
      partialOutputNotice,
      `An honest partial-output notice (text type) must be emitted when content was already emitted before malformed. Got types: ${msgs.map((m) => m.type).join(',')}`,
    );
  });
});

// ── AC-B7 (production hotfix): system_info/rate_limit must NOT block malformed recovery ──
//
// Production bug (砚砚 root cause analysis 2026-05-30):
// attemptHasContentOutput = true was set for system_info (rate_limit_event / agent_loop)
// because the condition excluded only error/done/session_init/provider_signal/liveness_signal/status
// but NOT system_info.
// Result: 136-event long Claude invocation had rate_limit system_info events before the
// thinking-only malformed turn → attemptHasContentOutput=true → malformed suppress guard failed
// → seal/retry/46接力 all skipped → user saw bare malformed error.
//
// Fix: attemptHasContentOutput must only be set by replay-sensitive types:
// text / tool_use / tool_result (types that would cause duplicate side-effects on retry).
// system_info, status, invocation_metrics, agent_loop etc. are metadata, not model output.

describe('F215 AC-B7 (hotfix): system_info/rate_limit before malformed must NOT block recovery', () => {
  test('malformed retry triggers when system_info (rate_limit) preceded the malformed turn', async () => {
    // Regression test for production bug: service emits system_info THEN malformed.
    // With the bug: attemptHasContentOutput=true → suppress guard fails → no retry.
    // After fix: system_info does NOT set attemptHasContentOutput → retry fires.
    const { invokeSingleCat } = await import('../dist/domains/cats/services/agents/invocation/invoke-single-cat.js');

    let invokeCount = 0;
    const rateLimitThenMalformedService = {
      async *invoke(_prompt, _opts) {
        invokeCount++;
        // system_info rate_limit (what ClaudeAgentService emits from transformClaudeEvent rate_limit_event)
        yield {
          type: 'system_info',
          catId: 'opus48',
          content: JSON.stringify({ type: 'rate_limit', message: 'throttled' }),
          timestamp: Date.now(),
        };
        // Then malformed (thinking-only)
        yield {
          type: 'system_info',
          catId: 'opus48',
          content: JSON.stringify({ type: 'malformed_toolcall_detected', sessionId: `ses-rl-${invokeCount}` }),
          timestamp: Date.now(),
        };
        yield {
          type: 'error',
          catId: 'opus48',
          error: 'malformed_toolcall: thinking-only after rate_limit',
          timestamp: Date.now(),
        };
        yield { type: 'done', catId: 'opus48', timestamp: Date.now() };
      },
    };
    let regCounterB7 = 0;
    const depsB7 = {
      registry: {
        create: async () => ({
          invocationId: `inv-b7-${++regCounterB7}`,
          callbackToken: `tok-b7-${regCounterB7}`,
        }),
        verify: async () => ({ ok: false, reason: 'unknown_invocation' }),
      },
      sessionManager: {
        get: async () => undefined,
        getOrCreate: async () => ({}),
        store: async () => {},
        delete: async () => {},
        resolveWorkingDirectory: () => '/tmp/test',
      },
      threadStore: null,
      apiUrl: 'http://127.0.0.1:3004',
    };

    const msgs = [];
    for await (const msg of invokeSingleCat(depsB7, {
      catId: 'opus48',
      service: rateLimitThenMalformedService,
      prompt: 'rate_limit then malformed test',
      userId: 'user-b7',
      threadId: 'thread-b7',
      isLastCat: true,
    })) {
      msgs.push(msg);
    }

    // Service MUST be called more than once (retry fired) — system_info must NOT block recovery
    assert.ok(
      invokeCount > 1,
      `Service must be called >1 time (retry fired). Was called: ${invokeCount}. system_info/rate_limit must not set attemptHasContentOutput (production bug)`,
    );
  });
});

// ── AC-C1/C2 integration: isMalformedToolCallError helper ──
// These test the helper function used by invoke-single-cat for detection.

describe('F215 AC-C1: isMalformedToolCallError detection helper', () => {
  test('isMalformedToolCallError detects malformed_toolcall: prefix', async () => {
    const { isMalformedToolCallError } = await import(
      '../dist/domains/cats/services/agents/invocation/invoke-helpers.js'
    );

    assert.equal(
      isMalformedToolCallError('malformed_toolcall: Opus 炸毛了——thinking-only 输出，无 tool_use / text block'),
      true,
      'Should detect malformed_toolcall: prefix',
    );
    assert.equal(
      isMalformedToolCallError('malformed_toolcall: anything'),
      true,
      'Should detect any malformed_toolcall: prefix',
    );
    assert.equal(
      isMalformedToolCallError('No conversation found with session ID abc'),
      false,
      'Should not match missing session error',
    );
    assert.equal(
      isMalformedToolCallError('Claude CLI: 检测到损坏的 thinking signature'),
      false,
      'Should not match thinking signature error',
    );
    assert.equal(isMalformedToolCallError(undefined), false, 'Should not match undefined');
    assert.equal(isMalformedToolCallError(''), false, 'Should not match empty string');
  });
});
