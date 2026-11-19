import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { normalizeOpenCodeEvent } from '../src/runtime/opencode-event-parser.ts';

/**
 * Raw `opencode run --format json` NDJSON → a provider-neutral wire event.
 *
 * The package extracts; the Host maps the wire event onto its own `AgentMessage`.
 * Two rules make that split safe:
 *
 *  - nothing Host-internal (catId, sanitisation, error text policy) leaks in here;
 *  - token arithmetic the CLI's shape forces on us is done once, at the source.
 */
describe('OpenCode event normalisation', () => {
  test('step_start establishes the session', () => {
    const parsed = normalizeOpenCodeEvent({ type: 'step_start', sessionID: 'ses_1', timestamp: 5 });

    assert.deepEqual(parsed, { kind: 'session_init', sessionId: 'ses_1', timestamp: 5 });
  });

  test('text becomes assistant text', () => {
    const parsed = normalizeOpenCodeEvent({ type: 'text', part: { type: 'text', text: 'hi' }, timestamp: 7 });

    assert.deepEqual(parsed, { kind: 'text', text: 'hi', timestamp: 7 });
  });

  test('text marked as reasoning routes to thinking, not output', () => {
    const parsed = normalizeOpenCodeEvent({
      type: 'text',
      part: { type: 'reasoning', text: 'pondering' },
      timestamp: 7,
    });

    assert.deepEqual(parsed, { kind: 'thinking', text: 'pondering', timestamp: 7 });
  });

  test('a dedicated reasoning event also routes to thinking', () => {
    const parsed = normalizeOpenCodeEvent({ type: 'reasoning', part: { text: 'hmm' }, timestamp: 8 });

    assert.deepEqual(parsed, { kind: 'thinking', text: 'hmm', timestamp: 8 });
  });

  test('tool_use carries the tool name and its input', () => {
    const parsed = normalizeOpenCodeEvent({
      type: 'tool_use',
      part: { tool: 'bash', state: { input: { cmd: 'ls' } } },
      timestamp: 9,
    });

    assert.deepEqual(parsed, { kind: 'tool', name: 'bash', input: { cmd: 'ls' }, timestamp: 9 });
  });

  test('tool_use without a name falls back rather than dropping the event', () => {
    const parsed = normalizeOpenCodeEvent({ type: 'tool_use', part: { state: {} }, timestamp: 9 });

    assert.equal(parsed.kind, 'tool');
    assert.equal(parsed.name, 'unknown');
  });

  test('step_finish sums fresh and cached input tokens', () => {
    const parsed = normalizeOpenCodeEvent({
      type: 'step_finish',
      part: { tokens: { input: 671, output: 30, total: 701, cache: { read: 21_000, write: 500 } }, cost: 0.02 },
      timestamp: 10,
    });

    assert.equal(parsed.kind, 'usage');
    // 671 fresh + 21_000 read + 500 write: the shared contract wants TOTAL prompt tokens,
    // and F24's fill ratio reads lastTurnInputTokens — a fresh-only number underflows.
    assert.equal(parsed.usage.inputTokens, 22_171);
    assert.equal(parsed.usage.lastTurnInputTokens, 22_171);
    assert.equal(parsed.usage.outputTokens, 30);
    assert.equal(parsed.usage.totalTokens, 701);
    assert.equal(parsed.usage.cacheReadTokens, 21_000);
    assert.equal(parsed.usage.cacheCreationTokens, 500);
    assert.equal(parsed.usage.costUsd, 0.02);
  });

  test('a non-numeric cost is dropped while the token telemetry still lands', () => {
    // The CLI reports cost:'unknown' on steps it could not price. The Host contract
    // types costUsd as a number, so passing the string straight through fails contract
    // validation and ends a turn that had a perfectly good answer. The baseline dropped
    // the unusable cost and kept the tokens; so must this.
    const parsed = normalizeOpenCodeEvent({
      type: 'step_finish',
      part: { tokens: { input: 10, output: 5, total: 15 }, cost: 'unknown' },
      timestamp: 11,
    });

    assert.equal(parsed.kind, 'usage');
    assert.equal(parsed.usage.inputTokens, 10);
    assert.equal(parsed.usage.outputTokens, 5);
    assert.equal(parsed.usage.costUsd, undefined);
  });

  test('a numeric-string cost is not invented into a number', () => {
    // Keeping the baseline's strictness: only real numbers are trusted cost evidence.
    const parsed = normalizeOpenCodeEvent({
      type: 'step_finish',
      part: { tokens: { input: 10, output: 5 }, cost: '0.02' },
      timestamp: 12,
    });

    assert.equal(parsed.kind, 'usage');
    assert.equal(parsed.usage.costUsd, undefined);
  });

  test('step_finish with no telemetry at all produces nothing', () => {
    const parsed = normalizeOpenCodeEvent({ type: 'step_finish', part: {}, timestamp: 10 });

    assert.equal(parsed.kind, 'ignored');
  });

  test('zero cache values are omitted rather than reported as activity', () => {
    const parsed = normalizeOpenCodeEvent({
      type: 'step_finish',
      part: { tokens: { input: 10, output: 5 } },
      timestamp: 10,
    });

    assert.equal(parsed.kind, 'usage');
    assert.equal(parsed.usage.cacheReadTokens, undefined);
    assert.equal(parsed.usage.cacheCreationTokens, undefined);
  });

  test('an error event reads only declared fields, never the raw body', () => {
    const parsed = normalizeOpenCodeEvent({
      type: 'error',
      error: { name: 'ProviderError', data: { message: 'bad key', statusCode: 401 } },
      timestamp: 11,
    });

    assert.deepEqual(parsed, { kind: 'error', message: 'bad key', statusCode: 401, timestamp: 11 });
  });

  test('unknown and malformed events are ignored, not thrown', () => {
    assert.equal(normalizeOpenCodeEvent({ type: 'weird' }).kind, 'ignored');
    assert.equal(normalizeOpenCodeEvent(null).kind, 'ignored');
    assert.equal(normalizeOpenCodeEvent({}).kind, 'ignored');
  });
});
