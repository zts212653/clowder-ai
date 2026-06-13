import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { transformOpenCodeEvent } from '../dist/domains/cats/services/agents/providers/opencode-event-transform.js';

const catId = 'opencode';

describe('transformOpenCodeEvent', () => {
  // ── step_start → session_init ──
  test('maps step_start → session_init with sessionID', () => {
    const event = {
      type: 'step_start',
      timestamp: 1773304958492,
      sessionID: 'ses_31ec9cff6ffe2fh92VnIubiN7o',
      part: { type: 'step-start', id: 'prt_xxx', sessionID: 'ses_31ec9cff6ffe2fh92VnIubiN7o', messageID: 'msg_xxx' },
    };
    const result = transformOpenCodeEvent(event, catId);
    assert.ok(result);
    assert.strictEqual(result.type, 'session_init');
    assert.strictEqual(result.sessionId, 'ses_31ec9cff6ffe2fh92VnIubiN7o');
    assert.strictEqual(result.catId, catId);
  });

  // ── text → text ──
  test('maps text → text with content', () => {
    const event = {
      type: 'text',
      timestamp: 1773304958494,
      sessionID: 'ses_xxx',
      part: { type: 'text', text: 'HELLO_OPENCODE', time: { start: 1773304958493, end: 1773304958493 } },
    };
    const result = transformOpenCodeEvent(event, catId);
    assert.ok(result);
    assert.strictEqual(result.type, 'text');
    assert.strictEqual(result.content, 'HELLO_OPENCODE');
    assert.strictEqual(result.catId, catId);
  });

  // ── tool_use → tool_use ──
  test('maps tool_use → tool_use with toolName and toolInput', () => {
    const event = {
      type: 'tool_use',
      timestamp: 1773304980356,
      sessionID: 'ses_xxx',
      part: {
        type: 'tool',
        callID: 'toolu_xxx',
        tool: 'bash',
        state: {
          status: 'completed',
          input: { command: 'ls -la', description: 'List files' },
          output: 'file1.txt\nfile2.txt',
        },
      },
    };
    const result = transformOpenCodeEvent(event, catId);
    assert.ok(result);
    assert.strictEqual(result.type, 'tool_use');
    assert.strictEqual(result.toolName, 'bash');
    assert.deepStrictEqual(result.toolInput, { command: 'ls -la', description: 'List files' });
  });

  // ── tool_use completed → also yields tool_result ──
  test('maps tool_use with completed status including output', () => {
    const event = {
      type: 'tool_use',
      timestamp: 1773304980356,
      sessionID: 'ses_xxx',
      part: {
        type: 'tool',
        callID: 'toolu_xxx',
        tool: 'read',
        state: { status: 'completed', input: { path: '/tmp/file.txt' }, output: 'file contents' },
      },
    };
    const result = transformOpenCodeEvent(event, catId);
    assert.ok(result);
    // tool_use is the primary mapping; output is available in toolInput
    assert.strictEqual(result.type, 'tool_use');
    assert.strictEqual(result.toolName, 'read');
  });

  // ── step_finish → agent_loop + usage metadata (clowder#915 fix) ──
  test('maps step_finish → agent_loop carrying metadata.usage (clowder#915)', () => {
    const event = {
      type: 'step_finish',
      timestamp: 1773304958508,
      sessionID: 'ses_xxx',
      part: {
        type: 'step-finish',
        reason: 'stop',
        cost: 0.036973,
        tokens: { total: 36937, input: 36928, output: 9, reasoning: 0 },
      },
    };
    const result = transformOpenCodeEvent(event, catId);
    // Must NOT be null — previously usage was discarded so contextHealth never fired,
    // handoff never triggered, and opencode crashed at context limit (clowder#915).
    assert.ok(result, 'step_finish must emit a message so downstream contextHealth path lights up');
    assert.strictEqual(result.type, 'agent_loop', 'use telemetry-only type (no user-visible bubble)');
    assert.strictEqual(result.catId, catId);
    assert.ok(result.metadata, 'metadata must be set so invoke-single-cat F8/F24 block fires');
    assert.strictEqual(result.metadata.provider, 'opencode');
    assert.ok(result.metadata.usage, 'usage must be set so contextHealth can compute fillRatio');
    assert.strictEqual(result.metadata.usage.inputTokens, 36928);
    assert.strictEqual(result.metadata.usage.outputTokens, 9);
    assert.strictEqual(result.metadata.usage.totalTokens, 36937);
    assert.strictEqual(result.metadata.usage.costUsd, 0.036973);
    // lastTurnInputTokens is the per-call signal used by F24 for accurate context fill.
    // step_finish reports per-step input which IS per-API-call from opencode's perspective.
    assert.strictEqual(result.metadata.usage.lastTurnInputTokens, 36928);
    // clowder#915 R5 cloud P2: transformer must NOT attach a default
    // contextWindowSize — that would override `getContextWindowFallback`'s
    // precise lookup for known opencode models (e.g. claude-opus-4-6 → 200k).
    // The unknown-model default is now applied as a LAST RESORT inside
    // invoke-single-cat's helper, only after the fallback table also misses.
    assert.strictEqual(result.metadata.usage.contextWindowSize, undefined);
  });

  test('clowder#915 R4 cloud P1 #1: step_finish includes cache.read/cache.write in inputTokens', () => {
    // opencode CLI reports cached prompt tokens under tokens.cache.{read,write}
    // SEPARATELY from tokens.input (which is only fresh-this-step). Per shared
    // TokenUsage contract, inputTokens/lastTurnInputTokens MUST represent the
    // TOTAL input (fresh + cached) since F24 uses lastTurnInputTokens as the
    // context-fill numerator. Cloud's failing scenario: 671 fresh + 21k cached
    // would look like 671 tokens → fillRatio ≈ 0 → handoff never fires.
    const event = {
      type: 'step_finish',
      timestamp: 1773304958508,
      sessionID: 'ses_xxx',
      part: {
        type: 'step-finish',
        reason: 'stop',
        cost: 0.012,
        tokens: {
          total: 21_680, // 671 + 21_000 + 9 = 21_680 (sanity)
          input: 671, // fresh this step
          output: 9,
          cache: {
            read: 21_000, // resumed-context reuse
            write: 0,
          },
        },
      },
    };
    const result = transformOpenCodeEvent(event, catId);
    assert.ok(result);
    assert.strictEqual(result.type, 'agent_loop');
    // inputTokens MUST be total (fresh + cache.read + cache.write), NOT just 671
    assert.strictEqual(result.metadata.usage.inputTokens, 21_671);
    assert.strictEqual(result.metadata.usage.lastTurnInputTokens, 21_671);
    // Observability: cache breakdown surfaces on TokenUsage
    assert.strictEqual(result.metadata.usage.cacheReadTokens, 21_000);
    // cacheCreationTokens absent because cache.write was 0 (we skip zero-valued)
    assert.strictEqual(result.metadata.usage.cacheCreationTokens, undefined);
  });

  test('clowder#915 R4 cloud P1 #1: step_finish with cache.write only (first-time cache population)', () => {
    // Edge case: cache.write reports prompt tokens being CACHED for first time
    // (paid as fresh input + cached for next step). MUST also count toward
    // inputTokens for accurate fillRatio.
    const event = {
      type: 'step_finish',
      timestamp: 1773304958508,
      sessionID: 'ses_xxx',
      part: {
        type: 'step-finish',
        cost: 0.05,
        tokens: {
          total: 10_500,
          input: 500,
          output: 0,
          cache: { read: 0, write: 10_000 },
        },
      },
    };
    const result = transformOpenCodeEvent(event, catId);
    assert.ok(result);
    assert.strictEqual(result.metadata.usage.inputTokens, 10_500); // 500 + 0 + 10_000
    assert.strictEqual(result.metadata.usage.lastTurnInputTokens, 10_500);
    assert.strictEqual(result.metadata.usage.cacheCreationTokens, 10_000);
  });

  test('clowder#915 R5 cloud P2: transformer leaves contextWindowSize blank — invoke-single-cat resolves via 3-tier chain', () => {
    // After R5: transformer never sets contextWindowSize. Window resolution
    // happens in invoke-single-cat.ts via:
    //   usage.contextWindowSize ?? getContextWindowFallback(model) ?? (provider==='opencode' ? OPENCODE_DEFAULT : undefined)
    // This test pins the transformer's contract; the full chain is tested
    // end-to-end in invoke-single-cat.test.js (clowder#915 R5 fallback test).
    const event = {
      type: 'step_finish',
      timestamp: 1773304958508,
      sessionID: 'ses_xxx',
      part: {
        type: 'step-finish',
        reason: 'tool-calls',
        cost: 0.02,
        tokens: { total: 109_000, input: 109_000, output: 0 },
      },
    };
    const result = transformOpenCodeEvent(event, catId);
    assert.ok(result);
    // contextWindowSize MUST be undefined — leaving it for the helper to resolve
    assert.strictEqual(result.metadata.usage.contextWindowSize, undefined);
    // Usage data still surfaces correctly
    assert.strictEqual(result.metadata.usage.inputTokens, 109_000);
    assert.strictEqual(result.metadata.usage.lastTurnInputTokens, 109_000);
  });

  test('step_finish with no tokens still returns a message but with empty usage', () => {
    // Defensive: opencode may emit step_finish without token data (e.g. cached responses).
    // Don't crash — return null in that degenerate case so we don't litter agent_loop
    // events that have no telemetry value.
    const event = {
      type: 'step_finish',
      timestamp: 1773304958508,
      sessionID: 'ses_xxx',
      part: { type: 'step-finish', reason: 'stop' },
    };
    const result = transformOpenCodeEvent(event, catId);
    assert.strictEqual(result, null, 'no tokens → nothing to telemeter → skip');
  });

  // ── error → error ──
  test('maps error event → error', () => {
    const event = {
      type: 'error',
      timestamp: 1773298718314,
      sessionID: 'ses_xxx',
      error: { name: 'APIError', data: { message: 'Rate limit exceeded', statusCode: 429 } },
    };
    const result = transformOpenCodeEvent(event, catId);
    assert.ok(result);
    assert.strictEqual(result.type, 'error');
    assert.ok(result.error);
    assert.ok(result.error.includes('Rate limit exceeded'));
  });

  // ── unknown → null ──
  test('returns null for unknown event type', () => {
    const event = { type: 'heartbeat', timestamp: 123456, sessionID: 'ses_xxx' };
    const result = transformOpenCodeEvent(event, catId);
    assert.strictEqual(result, null);
  });

  // ── graceful handling ──
  test('returns null for non-object input', () => {
    const result = transformOpenCodeEvent('not an object', catId);
    assert.strictEqual(result, null);
  });

  test('returns null for event missing type', () => {
    const result = transformOpenCodeEvent({ timestamp: 123 }, catId);
    assert.strictEqual(result, null);
  });

  // ── timestamp ──
  test('uses event timestamp in output', () => {
    const event = {
      type: 'text',
      timestamp: 1773304958494,
      sessionID: 'ses_xxx',
      part: { type: 'text', text: 'hello' },
    };
    const result = transformOpenCodeEvent(event, catId);
    assert.ok(result);
    assert.strictEqual(result.timestamp, 1773304958494);
  });
});
