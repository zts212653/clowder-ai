/**
 * CatAgent Phase B Completion Tests — F159 AC-B3 + AC-B4
 *
 * AC-B3: Tool parameter injection prevention
 *   - Schema validation (undeclared fields, type mismatch, missing required)
 *   - Shell-safe command building (flag injection, -- separator)
 *
 * AC-B4: Provider terminal state audit bridge
 *   - Anthropic usage → TokenUsage mapping
 *   - Anthropic response → AgentMessage mapping (text, tool_use, done)
 *   - Error → error + done (no dangling sessions)
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

// ── AC-B3: Tool Guard ──

const { validateToolInput, buildSafeCommand, ToolInputValidationError } = await import(
  '../dist/domains/cats/services/agents/providers/catagent/catagent-tool-guard.js'
);

const READ_FILE_SCHEMA = {
  name: 'read_file',
  description: 'Read a file',
  input_schema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path' },
      offset: { type: 'number', description: 'Start line' },
    },
    required: ['path'],
  },
};

// ── B3: Schema validation ──

test('B3: validateToolInput accepts valid input', () => {
  assert.doesNotThrow(() => validateToolInput(READ_FILE_SCHEMA, { path: 'src/index.ts' }));
});

test('B3: validateToolInput accepts valid input with optional fields', () => {
  assert.doesNotThrow(() => validateToolInput(READ_FILE_SCHEMA, { path: 'src/index.ts', offset: 10 }));
});

test('B3: validateToolInput rejects undeclared fields (constructor pollution)', () => {
  assert.throws(
    () => validateToolInput(READ_FILE_SCHEMA, { path: 'src/index.ts', constructor: 'polluted' }),
    (err) => err instanceof ToolInputValidationError && err.reason.includes('undeclared field "constructor"'),
  );
});

test('B3: validateToolInput rejects extra unknown field', () => {
  assert.throws(
    () => validateToolInput(READ_FILE_SCHEMA, { path: 'src/index.ts', deleteAll: true }),
    (err) => err instanceof ToolInputValidationError && err.reason.includes('undeclared field "deleteAll"'),
  );
});

test('B3: validateToolInput rejects missing required field', () => {
  assert.throws(
    () => validateToolInput(READ_FILE_SCHEMA, {}),
    (err) => err instanceof ToolInputValidationError && err.reason.includes('required field "path" is missing'),
  );
});

test('B3: validateToolInput rejects empty required string field', () => {
  assert.throws(
    () => validateToolInput(READ_FILE_SCHEMA, { path: '   ' }),
    (err) => err instanceof ToolInputValidationError && err.reason.includes('required field "path" is empty'),
  );
});

test('B3: validateToolInput rejects type mismatch (string expected, number given)', () => {
  assert.throws(
    () => validateToolInput(READ_FILE_SCHEMA, { path: 42 }),
    (err) => err instanceof ToolInputValidationError && err.reason.includes('expected type "string", got "number"'),
  );
});

test('B3: validateToolInput rejects type mismatch (number expected, string given)', () => {
  assert.throws(
    () => validateToolInput(READ_FILE_SCHEMA, { path: 'ok', offset: 'not-a-number' }),
    (err) => err instanceof ToolInputValidationError && err.reason.includes('expected type "number", got "string"'),
  );
});

test('B3: validateToolInput skips type check for absent optional fields', () => {
  assert.doesNotThrow(() => validateToolInput(READ_FILE_SCHEMA, { path: 'src/index.ts' }));
});

// ── B3: Shell-safe command building ──

test('B3: buildSafeCommand produces correct array with -- separator', () => {
  const [bin, args] = buildSafeCommand('rg', ['--json', '-n'], ['hello world']);
  assert.equal(bin, 'rg');
  assert.deepEqual(args, ['--json', '-n', '--', 'hello world']);
});

test('B3: buildSafeCommand rejects flag injection in user args (--delete)', () => {
  assert.throws(
    () => buildSafeCommand('rg', ['--json'], ['--delete']),
    (err) => err instanceof ToolInputValidationError && err.reason.includes('looks like a flag'),
  );
});

test('B3: buildSafeCommand rejects flag injection (-e)', () => {
  assert.throws(
    () => buildSafeCommand('rg', [], ['-e', 'malicious']),
    (err) => err instanceof ToolInputValidationError && err.reason.includes('looks like a flag'),
  );
});

test('B3: buildSafeCommand rejects single dash flag', () => {
  assert.throws(
    () => buildSafeCommand('rg', [], ['-n']),
    (err) => err instanceof ToolInputValidationError && err.reason.includes('looks like a flag'),
  );
});

test('B3: buildSafeCommand allows normal patterns', () => {
  const [, args] = buildSafeCommand('rg', ['--json'], ['function\\s+\\w+']);
  assert.deepEqual(args, ['--json', '--', 'function\\s+\\w+']);
});

test('B3: buildSafeCommand allows patterns with special chars', () => {
  const [, args] = buildSafeCommand('rg', [], ['hello; rm -rf /']);
  // Shell injection harmless: execFile doesn't interpret shell metacharacters
  assert.deepEqual(args, ['--', 'hello; rm -rf /']);
});

// ── AC-B4: Event Bridge ──

const { mapAnthropicUsage, mapAnthropicResponse, mapAnthropicError } = await import(
  '../dist/domains/cats/services/agents/providers/catagent/catagent-event-bridge.js'
);

// ── B4: Usage mapping ──

test('B4: mapAnthropicUsage converts full usage correctly', () => {
  const result = mapAnthropicUsage({
    input_tokens: 100,
    output_tokens: 50,
    cache_read_input_tokens: 20,
    cache_creation_input_tokens: 10,
  });
  assert.equal(result.inputTokens, 130, 'inputTokens = 100 + 20 + 10');
  assert.equal(result.outputTokens, 50);
  assert.equal(result.cacheReadTokens, 20);
  assert.equal(result.cacheCreationTokens, 10);
});

test('B4: mapAnthropicUsage handles no cache tokens', () => {
  const result = mapAnthropicUsage({ input_tokens: 80, output_tokens: 40 });
  assert.equal(result.inputTokens, 80);
  assert.equal(result.outputTokens, 40);
  assert.equal(result.cacheReadTokens, undefined);
  assert.equal(result.cacheCreationTokens, undefined);
});

test('B4: mapAnthropicUsage returns zeros for undefined usage', () => {
  const result = mapAnthropicUsage(undefined);
  assert.equal(result.inputTokens, 0);
  assert.equal(result.outputTokens, 0);
});

test('B4: mapAnthropicUsage returns zeros for empty object', () => {
  const result = mapAnthropicUsage({});
  assert.equal(result.inputTokens, 0);
  assert.equal(result.outputTokens, 0);
});

test('B4: mapAnthropicUsage handles non-numeric fields gracefully', () => {
  const result = mapAnthropicUsage({ input_tokens: 'bad', output_tokens: null });
  assert.equal(result.inputTokens, 0);
  assert.equal(result.outputTokens, 0);
});

// ── B4: Response mapping ──

test('B4: mapAnthropicResponse maps text content to text message', () => {
  const msgs = mapAnthropicResponse(
    {
      id: 'msg_1',
      model: 'claude-opus-4-20250514',
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'Hello world' }],
      usage: { input_tokens: 10, output_tokens: 5 },
    },
    'ragdoll',
    'catagent',
  );
  assert.equal(msgs.length, 2, 'text + done');
  assert.equal(msgs[0].type, 'text');
  assert.equal(msgs[0].content, 'Hello world');
  assert.equal(msgs[0].catId, 'ragdoll');
  assert.equal(msgs[1].type, 'done');
  assert.equal(msgs[1].metadata.provider, 'catagent');
  assert.equal(msgs[1].metadata.model, 'claude-opus-4-20250514');
  assert.equal(msgs[1].metadata.usage.inputTokens, 10);
});

test('B4: mapAnthropicResponse does NOT emit done for stop_reason tool_use (turn boundary)', () => {
  const msgs = mapAnthropicResponse(
    {
      id: 'msg_2',
      model: 'claude-sonnet-4-20250514',
      stop_reason: 'tool_use',
      content: [{ type: 'tool_use', id: 'toolu_1', name: 'read_file', input: { path: 'index.ts' } }],
      usage: { input_tokens: 20, output_tokens: 15 },
    },
    'ragdoll',
    'catagent',
  );
  assert.equal(msgs.length, 1, 'tool_use only — no done for turn boundary');
  assert.equal(msgs[0].type, 'tool_use');
  assert.equal(msgs[0].toolName, 'read_file');
  assert.deepEqual(msgs[0].toolInput, { path: 'index.ts' });
});

test('B4: mapAnthropicResponse omits done for mixed content with tool_use stop', () => {
  const msgs = mapAnthropicResponse(
    {
      id: 'msg_3',
      model: 'claude-opus-4-20250514',
      stop_reason: 'tool_use',
      content: [
        { type: 'text', text: 'Let me read that file.' },
        { type: 'tool_use', id: 'toolu_2', name: 'read_file', input: { path: 'a.ts' } },
      ],
      usage: { input_tokens: 30, output_tokens: 20 },
    },
    'ragdoll',
    'catagent',
  );
  assert.equal(msgs.length, 2, 'text + tool_use — no done for turn boundary');
  assert.equal(msgs[0].type, 'text');
  assert.equal(msgs[1].type, 'tool_use');
});

test('B4: mapAnthropicResponse emits done for end_turn (terminal)', () => {
  const msgs = mapAnthropicResponse(
    {
      id: 'msg_term',
      model: 'claude-opus-4-20250514',
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'Done.' }],
      usage: { input_tokens: 10, output_tokens: 5 },
    },
    'ragdoll',
    'catagent',
  );
  assert.equal(msgs.length, 2, 'text + done for terminal');
  assert.equal(msgs[0].type, 'text');
  assert.equal(msgs[1].type, 'done');
  assert.equal(msgs[1].metadata.usage.inputTokens, 10);
});

test('B4: mapAnthropicResponse emits done for max_tokens (terminal)', () => {
  const msgs = mapAnthropicResponse(
    {
      id: 'msg_max',
      model: 'claude-opus-4-20250514',
      stop_reason: 'max_tokens',
      content: [{ type: 'text', text: 'Truncat' }],
      usage: { input_tokens: 50, output_tokens: 4096 },
    },
    'ragdoll',
    'catagent',
  );
  assert.equal(msgs.length, 2, 'text + done for max_tokens');
  assert.equal(msgs[1].type, 'done');
});

test('B4: mapAnthropicResponse emits done for stop_sequence (terminal)', () => {
  const msgs = mapAnthropicResponse(
    {
      id: 'msg_stop_seq',
      model: 'claude-opus-4-20250514',
      stop_reason: 'stop_sequence',
      content: [{ type: 'text', text: 'Output until stop' }],
      usage: { input_tokens: 15, output_tokens: 8 },
    },
    'ragdoll',
    'catagent',
  );
  assert.equal(msgs.length, 2, 'text + done for stop_sequence');
  assert.equal(msgs[1].type, 'done');
});

test('B4: mapAnthropicResponse emits done for refusal (terminal)', () => {
  const msgs = mapAnthropicResponse(
    {
      id: 'msg_refuse',
      model: 'claude-opus-4-20250514',
      stop_reason: 'refusal',
      content: [],
      usage: { input_tokens: 20, output_tokens: 0 },
    },
    'ragdoll',
    'catagent',
  );
  assert.equal(msgs.length, 1, 'done only for refusal');
  assert.equal(msgs[0].type, 'done');
});

test('B4: mapAnthropicResponse emits done for model_context_window_exceeded (terminal)', () => {
  const msgs = mapAnthropicResponse(
    {
      id: 'msg_ctx',
      model: 'claude-opus-4-20250514',
      stop_reason: 'model_context_window_exceeded',
      content: [],
      usage: { input_tokens: 200000, output_tokens: 0 },
    },
    'ragdoll',
    'catagent',
  );
  assert.equal(msgs.length, 1, 'done only for context window exceeded');
  assert.equal(msgs[0].type, 'done');
});

test('B4: mapAnthropicResponse does NOT emit done for pause_turn (server tools)', () => {
  const msgs = mapAnthropicResponse(
    {
      id: 'msg_pause',
      model: 'claude-opus-4-20250514',
      stop_reason: 'pause_turn',
      content: [{ type: 'text', text: 'Thinking...' }],
      usage: { input_tokens: 10, output_tokens: 5 },
    },
    'ragdoll',
    'catagent',
  );
  assert.equal(msgs.length, 1, 'text only — no done for pause_turn');
  assert.equal(msgs[0].type, 'text');
});

test('B4: mapAnthropicResponse does NOT emit done for null stop_reason (streaming initial)', () => {
  const msgs = mapAnthropicResponse(
    {
      id: 'msg_null',
      model: 'claude-opus-4-20250514',
      stop_reason: null,
      content: [{ type: 'text', text: 'streaming...' }],
      usage: { input_tokens: 5, output_tokens: 2 },
    },
    'ragdoll',
    'catagent',
  );
  assert.equal(msgs.length, 1, 'text only — no done for null stop_reason');
  assert.equal(msgs[0].type, 'text');
});

test('B4: mapAnthropicResponse handles empty content', () => {
  const msgs = mapAnthropicResponse(
    {
      id: 'msg_4',
      model: 'claude-opus-4-20250514',
      stop_reason: 'end_turn',
      content: [],
      usage: { input_tokens: 5, output_tokens: 0 },
    },
    'ragdoll',
    'catagent',
  );
  assert.equal(msgs.length, 1, 'only done');
  assert.equal(msgs[0].type, 'done');
});

test('B4: mapAnthropicResponse includes usage in done message even with missing usage', () => {
  const msgs = mapAnthropicResponse(
    { id: 'msg_5', model: 'claude-opus-4-20250514', stop_reason: 'end_turn', content: [] },
    'ragdoll',
    'catagent',
  );
  assert.equal(msgs[0].type, 'done');
  assert.equal(msgs[0].metadata.usage.inputTokens, 0, 'graceful zero for missing usage');
  assert.equal(msgs[0].metadata.usage.outputTokens, 0);
});

// ── B4: Error mapping ──

test('B4: mapAnthropicError produces error + done (two events)', () => {
  const msgs = mapAnthropicError(
    { status: 429, message: 'Rate limited' },
    'ragdoll',
    'catagent',
    'claude-opus-4-20250514',
  );
  assert.equal(msgs.length, 2, 'error + done');
  assert.equal(msgs[0].type, 'error');
  assert.ok(msgs[0].error.includes('429'));
  assert.ok(msgs[0].error.includes('Rate limited'));
  assert.equal(msgs[1].type, 'done');
  assert.equal(msgs[1].metadata.usage.inputTokens, 0, 'zero usage on error');
});

test('B4: mapAnthropicError handles missing status and message', () => {
  const msgs = mapAnthropicError({}, 'ragdoll', 'catagent', 'claude-opus-4-20250514');
  assert.equal(msgs.length, 2);
  assert.ok(msgs[0].error.includes('0'));
  assert.ok(msgs[0].error.includes('Unknown API error'));
});

test('B4: mapAnthropicError includes provider metadata in done', () => {
  const msgs = mapAnthropicError({ status: 500 }, 'ragdoll', 'catagent', 'claude-opus-4-20250514');
  assert.equal(msgs[1].metadata.provider, 'catagent');
  assert.equal(msgs[1].metadata.model, 'claude-opus-4-20250514');
});

test('B4: all messages have timestamp', () => {
  const before = Date.now();
  const msgs = mapAnthropicResponse(
    {
      id: 'msg_ts',
      model: 'claude-opus-4-20250514',
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'hi' }],
      usage: { input_tokens: 1, output_tokens: 1 },
    },
    'ragdoll',
    'catagent',
  );
  const after = Date.now();
  for (const msg of msgs) {
    assert.ok(msg.timestamp >= before && msg.timestamp <= after, `timestamp ${msg.timestamp} in range`);
  }
});
