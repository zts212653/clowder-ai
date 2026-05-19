/**
 * F198 Phase B Step 2: Parity Gate Golden Tests
 *
 * Asserts `BgTranscriptEventConsumer` produces AgentMessages equivalent to
 * the -p NDJSON path via transformClaudeEvent (single source of truth).
 *
 * 砚砚 cross-cat Design Gate (2026-05-14) + slice 1 review:
 * - P1.1: lifecycle (session_init/done) is caller responsibility, not embedded
 * - P1.2: usage extraction MUST reuse extractClaudeUsage (no duplicated rules)
 * - real-sample `system` subtypes: turn_duration (surface) / stop_hook_summary (skip)
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  extractTranscriptUsage,
  transcriptEntriesToAgentMessages,
} from '../dist/domains/cats/services/agents/providers/BgTranscriptEventConsumer.js';
import {
  extractClaudeUsage,
  transformClaudeEvent,
} from '../dist/domains/cats/services/agents/providers/claude-ndjson-parser.js';

const CAT_ID = 'opus';

/** Run -p NDJSON events through existing transformer, mimicking ClaudeAgentService.invoke(). */
function runNdjsonBaseline(events, catId) {
  const out = [];
  const state = {
    currentMessageId: undefined,
    partialTextMessageIds: new Set(),
    lastTurnInputTokens: undefined,
    thinkingBuffer: '',
  };
  for (const e of events) {
    const result = transformClaudeEvent(e, catId, state);
    if (result == null) continue;
    if (Array.isArray(result)) out.push(...result);
    else out.push(result);
  }
  return out;
}

/** Strip timestamps for stable deep-equal. */
function strip(messages) {
  return messages.map(({ timestamp: _t, ...rest }) => rest);
}

test('text-only assistant turn: produces single text AgentMessage matching -p baseline', () => {
  // Slice-1 review P1.1: this fn does NOT emit session_init/done — caller manages lifecycle.
  const assistantBlock = {
    id: 'msg_001',
    role: 'assistant',
    content: [{ type: 'text', text: 'Hello! 👋' }],
    usage: {
      input_tokens: 6,
      output_tokens: 11,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 52528,
    },
  };

  const ndjsonEvents = [{ type: 'assistant', message: assistantBlock }];
  const transcriptEntries = [{ type: 'assistant', message: assistantBlock, sessionId: 'x' }];

  const baseline = strip(runNdjsonBaseline(ndjsonEvents, CAT_ID));
  const candidate = strip(transcriptEntriesToAgentMessages(transcriptEntries, { catId: CAT_ID }));

  // Strict equality across the entire sequence — no filtering.
  assert.deepEqual(candidate, baseline, 'transcript candidate must equal -p baseline exactly');
  assert.equal(candidate.length, 1);
  assert.equal(candidate[0].type, 'text');
});

test('tool_use block: produces tool_use AgentMessage equivalent to -p path (R2 critical)', () => {
  // Hub observability — without tool_use visibility, --bg loses the
  // "what is the agent doing right now" signal vs -p.
  const assistantBlock = {
    id: 'msg_002',
    role: 'assistant',
    content: [
      { type: 'text', text: 'Let me check that file.' },
      { type: 'tool_use', id: 'tool_001', name: 'Read', input: { file_path: '/tmp/foo.txt' } },
    ],
    usage: { input_tokens: 50, output_tokens: 20 },
  };

  const baseline = strip(runNdjsonBaseline([{ type: 'assistant', message: assistantBlock }], CAT_ID));
  const candidate = strip(
    transcriptEntriesToAgentMessages([{ type: 'assistant', message: assistantBlock }], { catId: CAT_ID }),
  );

  assert.deepEqual(candidate, baseline, 'tool_use sequence must match -p baseline exactly');
  const toolUse = candidate.find((m) => m.type === 'tool_use');
  assert.ok(toolUse, 'must yield tool_use');
  assert.equal(toolUse.toolName, 'Read');
  assert.deepEqual(toolUse.toolInput, { file_path: '/tmp/foo.txt' });
});

test('system.turn_duration: surfaced as system_info (per real --bg sample)', () => {
  // Real sample (c555a987 2026-05-14): system entry with subtype=turn_duration
  // carries durationMs + messageCount.
  const entries = [{ type: 'system', subtype: 'turn_duration', durationMs: 6303, messageCount: 6 }];
  const out = transcriptEntriesToAgentMessages(entries, { catId: CAT_ID });
  assert.equal(out.length, 1);
  assert.equal(out[0].type, 'system_info');
  const payload = JSON.parse(out[0].content);
  assert.equal(payload.type, 'turn_duration');
  assert.equal(payload.durationMs, 6303);
  assert.equal(payload.messageCount, 6);
});

test('system.stop_hook_summary: skipped (hook diagnostics not user-facing)', () => {
  // Real sample: stop_hook_summary carries hookCount/hookInfos — noise.
  const entries = [
    {
      type: 'system',
      subtype: 'stop_hook_summary',
      hookCount: 2,
      hookInfos: [],
      preventedContinuation: false,
    },
  ];
  const out = transcriptEntriesToAgentMessages(entries, { catId: CAT_ID });
  assert.equal(out.length, 0, 'stop_hook_summary must produce no events (P3 noise)');
});

test('non-assistant noise types: last-prompt/file-history-snapshot/etc. skipped', () => {
  const entries = [
    { type: 'last-prompt', sessionId: 'x' },
    { type: 'permission-mode', permissionMode: 'default' },
    { type: 'file-history-snapshot', messageId: 'y', snapshot: {} },
    { type: 'agent-name', name: 'opus' },
    { type: 'ai-title', title: 'test' },
    { type: 'user', message: { role: 'user', content: 'hi' } },
    {
      type: 'assistant',
      message: {
        id: 'msg_n',
        role: 'assistant',
        content: [{ type: 'text', text: 'Reply.' }],
        usage: { input_tokens: 5, output_tokens: 3 },
      },
    },
  ];
  const out = transcriptEntriesToAgentMessages(entries, { catId: CAT_ID });
  // Exactly 1 event — the text from the single assistant entry.
  assert.equal(out.length, 1);
  assert.equal(out[0].type, 'text');
});

test('extractTranscriptUsage: aggregates per-turn usage via shared extractClaudeUsage', () => {
  // P1.2: must reuse extractClaudeUsage, not duplicate raw+cache rules.
  // Strategy: assert transcript path's TokenUsage equals what extractClaudeUsage
  // would return when given a synthetic result/success event with the same totals.
  const entries = [
    {
      type: 'assistant',
      message: {
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          cache_read_input_tokens: 100,
          cache_creation_input_tokens: 50,
        },
      },
    },
    {
      type: 'assistant',
      message: {
        usage: {
          input_tokens: 8,
          output_tokens: 4,
          cache_read_input_tokens: 200,
          cache_creation_input_tokens: 0,
        },
      },
    },
    { type: 'system', subtype: 'turn_duration', durationMs: 1500 },
    { type: 'system', subtype: 'turn_duration', durationMs: 2500 },
  ];

  const transcriptUsage = extractTranscriptUsage(entries, { totalCostUsd: 0.042 });

  // Equivalent synthetic result event (what extractClaudeUsage natively eats).
  const equivalent = extractClaudeUsage({
    type: 'result',
    subtype: 'success',
    usage: {
      input_tokens: 18,
      output_tokens: 9,
      cache_read_input_tokens: 300,
      cache_creation_input_tokens: 50,
    },
    total_cost_usd: 0.042,
    duration_ms: 4000, // 1500 + 2500
    num_turns: 2,
  });

  assert.deepEqual(
    transcriptUsage,
    equivalent,
    'transcript usage must match what extractClaudeUsage produces from equivalent synthetic event',
  );
  // Sanity: inputTokens = 18 + 300 + 50 = 368 (raw + cache_read + cache_creation).
  assert.equal(transcriptUsage.inputTokens, 368);
  assert.equal(transcriptUsage.outputTokens, 9);
  assert.equal(transcriptUsage.cacheReadTokens, 300);
  assert.equal(transcriptUsage.cacheCreationTokens, 50);
  assert.equal(transcriptUsage.costUsd, 0.042);
  assert.equal(transcriptUsage.durationMs, 4000);
  assert.equal(transcriptUsage.numTurns, 2);
});

test('extractTranscriptUsage: terminalMeta.durationMs overrides summed turn_duration', () => {
  // Carrier knows authoritative durationMs from state.json; option overrides.
  const entries = [
    { type: 'system', subtype: 'turn_duration', durationMs: 1000 },
    { type: 'system', subtype: 'turn_duration', durationMs: 2000 },
  ];
  const usage = extractTranscriptUsage(entries, { durationMs: 9999 });
  assert.equal(usage.durationMs, 9999, 'terminalMeta override wins over summed transcript');
});

test('extractTranscriptUsage: numTurns auto-counted from assistant entries when not provided', () => {
  const entries = [
    { type: 'assistant', message: { usage: {} } },
    { type: 'assistant', message: { usage: {} } },
    { type: 'assistant', message: { usage: {} } },
  ];
  const usage = extractTranscriptUsage(entries);
  assert.equal(usage.numTurns, 3, 'numTurns auto-counted from assistant entries');
});
