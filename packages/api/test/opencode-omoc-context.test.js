import assert from 'node:assert/strict';
import { describe, mock, test } from 'node:test';
import { OpenCodeAgentService } from '../dist/domains/cats/services/agents/providers/OpenCodeAgentService.js';
import { transformOpenCodeEvent } from '../dist/domains/cats/services/agents/providers/opencode-event-transform.js';
import { ensureFakeCliOnPath } from './helpers/fake-cli-path.js';
import { collect, createMockProcess, emitOpenCodeEvents } from './helpers/opencode-test-helpers.js';

ensureFakeCliOnPath('opencode');

// ── Ralph Loop fixtures: multiple step cycles ──

function makeStepStart(ts, sessionID = 'ses_ralph') {
  return {
    type: 'step_start',
    timestamp: ts,
    sessionID,
    part: { type: 'step-start', id: `prt_${ts}`, sessionID, messageID: `msg_${ts}` },
  };
}

function makeText(ts, text, sessionID = 'ses_ralph') {
  return {
    type: 'text',
    timestamp: ts,
    sessionID,
    part: { type: 'text', text, time: { start: ts, end: ts } },
  };
}

function makeToolUse(ts, tool, input, sessionID = 'ses_ralph') {
  return {
    type: 'tool_use',
    timestamp: ts,
    sessionID,
    part: {
      type: 'tool',
      callID: `toolu_${ts}`,
      tool,
      state: { status: 'completed', input, output: 'ok' },
    },
  };
}

function makeStepFinish(ts, tokens = 5000, sessionID = 'ses_ralph') {
  return {
    type: 'step_finish',
    timestamp: ts,
    sessionID,
    part: { type: 'step-finish', reason: 'stop', cost: 0.01, tokens: { total: tokens } },
  };
}

describe('Ralph Loop + Context Management (AC-11)', () => {
  // ── Ralph Loop: multiple step cycles produce valid event stream ──

  test('Ralph Loop: 3 consecutive step cycles yield correct message sequence', async () => {
    const proc = createMockProcess();
    const spawnFn = mock.fn(() => proc);
    const service = new OpenCodeAgentService({
      catId: 'opencode',
      spawnFn,
      model: 'claude-haiku-4-5',
    });

    // Ralph Loop = opencode auto-continues, producing multiple step cycles
    const events = [
      // Cycle 1
      makeStepStart(1000),
      makeText(1001, 'Step 1: Analyzing the codebase...'),
      makeToolUse(1002, 'bash', { command: 'find . -name "*.ts"' }),
      makeStepFinish(1003, 8000),
      // Cycle 2 (Ralph auto-continues)
      makeStepStart(2000),
      makeText(2001, 'Step 2: Found 15 files, now implementing changes...'),
      makeToolUse(2002, 'edit', { path: 'src/auth.ts', content: '...' }),
      makeStepFinish(2003, 12000),
      // Cycle 3 (Ralph auto-continues)
      makeStepStart(3000),
      makeText(3001, 'Step 3: Running tests to verify...'),
      makeToolUse(3002, 'bash', { command: 'npm test' }),
      makeStepFinish(3003, 16000),
    ];

    const promise = collect(service.invoke('Fix the auth module'));
    emitOpenCodeEvents(proc, events);
    const messages = await promise;

    // Should have exactly 1 session_init (from first step_start, deduped)
    const sessionInits = messages.filter((m) => m.type === 'session_init');
    assert.strictEqual(sessionInits.length, 1, 'Ralph Loop must not duplicate session_init');

    // Should have 3 text messages (one per cycle)
    const textMsgs = messages.filter((m) => m.type === 'text');
    assert.strictEqual(textMsgs.length, 3, `expected 3 text messages, got ${textMsgs.length}`);

    // Should have 3 tool_use messages (one per cycle)
    const toolUses = messages.filter((m) => m.type === 'tool_use');
    assert.strictEqual(toolUses.length, 3, `expected 3 tool_use messages, got ${toolUses.length}`);

    // Should have exactly 1 done (at the end)
    const dones = messages.filter((m) => m.type === 'done');
    assert.strictEqual(dones.length, 1, 'must have exactly 1 done');

    // step_finish events are mapped to null, so no extra messages
    // Total expected: 1 session_init + 3 text + 3 tool_use + 1 done = 8
    assert.strictEqual(messages.length, 8, `expected 8 messages total, got ${messages.length}`);
  });

  // ── Context management: elevated token counts are handled ──

  test('OMOC context management: high token counts in step_finish are ignored', () => {
    // OMOC adds ~12K system prompt tokens, so step_finish often shows 36K+ total
    const highTokenFinish = makeStepFinish(5000, 36937);
    const result = transformOpenCodeEvent(highTokenFinish, 'opencode');

    // step_finish → null (metadata only, not propagated)
    assert.strictEqual(result, null, 'step_finish with OMOC token overhead must still return null');
  });

  // ── Context warning: if opencode emits a text warning, it passes through ──

  test('context warning text passes through as regular text message', () => {
    // OMOC Context management may emit warnings at 70% usage
    const warningText = makeText(6000, '⚠️ Context usage at 72%. Consider compacting soon.');
    const result = transformOpenCodeEvent(warningText, 'opencode');

    assert.ok(result);
    assert.strictEqual(result.type, 'text');
    assert.ok(result.content.includes('Context usage'));
  });

  // ── Auto-compact: stream may have pause between cycles ──

  test('Ralph Loop with gap between cycles still produces valid stream', async () => {
    const proc = createMockProcess();
    const spawnFn = mock.fn(() => proc);
    const service = new OpenCodeAgentService({
      catId: 'opencode',
      spawnFn,
      model: 'claude-haiku-4-5',
    });

    // Simulate a gap where auto-compact might occur between cycles
    const events = [
      makeStepStart(1000),
      makeText(1001, 'Working...'),
      makeStepFinish(1002, 30000),
      // Large timestamp gap (auto-compact may have occurred)
      makeStepStart(10000),
      makeText(10001, 'Continuing after context management...'),
      makeStepFinish(10002, 15000), // Token count drops after compact
    ];

    const promise = collect(service.invoke('Long task'));
    emitOpenCodeEvents(proc, events);
    const messages = await promise;

    // Still produces valid message sequence
    const sessionInits = messages.filter((m) => m.type === 'session_init');
    assert.strictEqual(sessionInits.length, 1, 'only 1 session_init even after auto-compact');

    const textMsgs = messages.filter((m) => m.type === 'text');
    assert.strictEqual(textMsgs.length, 2);

    const dones = messages.filter((m) => m.type === 'done');
    assert.strictEqual(dones.length, 1);
  });

  // ── Unknown/heartbeat events during Ralph Loop are silently dropped ──

  test('unknown events between Ralph Loop cycles are silently dropped', async () => {
    const proc = createMockProcess();
    const spawnFn = mock.fn(() => proc);
    const service = new OpenCodeAgentService({
      catId: 'opencode',
      spawnFn,
      model: 'claude-haiku-4-5',
    });

    const events = [
      makeStepStart(1000),
      makeText(1001, 'Cycle 1'),
      makeStepFinish(1002),
      // Unknown events (heartbeat, progress, etc.)
      { type: 'heartbeat', timestamp: 1500, sessionID: 'ses_ralph' },
      { type: 'progress', timestamp: 1501, sessionID: 'ses_ralph', data: { percent: 50 } },
      // Next cycle
      makeStepStart(2000),
      makeText(2001, 'Cycle 2'),
      makeStepFinish(2002),
    ];

    const promise = collect(service.invoke('Task'));
    emitOpenCodeEvents(proc, events);
    const messages = await promise;

    // Unknown events should be dropped (transformOpenCodeEvent returns null)
    // Expected: 1 session_init + 2 text + 1 done = 4
    assert.strictEqual(messages.length, 4, `expected 4 messages, got ${messages.length}`);
  });

  // ── Ralph Loop continuation maintains consistent catId ──

  test('all messages across Ralph Loop cycles have consistent catId', async () => {
    const proc = createMockProcess();
    const spawnFn = mock.fn(() => proc);
    const service = new OpenCodeAgentService({
      catId: 'opencode',
      spawnFn,
      model: 'claude-haiku-4-5',
    });

    const events = [
      makeStepStart(1000),
      makeText(1001, 'Cycle 1'),
      makeStepFinish(1002),
      makeStepStart(2000),
      makeText(2001, 'Cycle 2'),
      makeStepFinish(2002),
    ];

    const promise = collect(service.invoke('Task'));
    emitOpenCodeEvents(proc, events);
    const messages = await promise;

    for (const m of messages) {
      assert.strictEqual(
        m.catId,
        'opencode',
        `all messages must have catId=opencode, got "${m.catId}" for type=${m.type}`,
      );
    }
  });
});
