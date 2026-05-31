// F212 Phase A — Task 2: classifyCliError 9-reasonCode whitelist (AC-A4 + AC-A8)

import assert from 'node:assert';
import test from 'node:test';
import { classifyCliError } from '../dist/utils/cli-diagnostics.js';

const fixtures = [
  // Existing (must regress — predates F212, must keep behavior)
  ['Invalid `signature` in `thinking` block: foo', 'invalid_thinking_signature'],
  ['Error: no rollout found for cli session abc', 'missing_rollout'],
  // New 7 (AC-A4)
  ['The supported API model names are deepseek-v4-pro or deepseek-v4-flash', 'model_not_found'],
  ['Unknown model: foo-bar-v9', 'model_not_found'],
  ['Error: model gpt-7-ultra not found', 'model_not_found'],
  ['401 Unauthorized', 'auth_failed'],
  ['Error: invalid api key sk-xxx', 'auth_failed'],
  ['Authentication failed: token expired', 'auth_failed'],
  ['429 Too Many Requests', 'quota_exceeded'],
  ['rate limit exceeded for org foo', 'quota_exceeded'],
  ['You have hit the usage limit', 'quota_exceeded'],
  ['fetch failed: connect ECONNREFUSED 127.0.0.1:9879', 'network_error'],
  ['Error: ETIMEDOUT after 30000ms', 'network_error'],
  ['getaddrinfo ENOTFOUND api.example.com', 'network_error'],
  ['Error loading config.toml: invalid transport "foo"', 'invalid_config'],
  ['Failed to parse config at line 3', 'invalid_config'],
  ['config.json is malformed', 'invalid_config'],
  ['Error: spawn ENOENT', 'spawn_failed'],
  ['Error: spawn EACCES', 'spawn_failed'],
  ['context length exceeded: 200000 tokens', 'context_window_exceeded'],
  ['maximum context: 128000 reached', 'context_window_exceeded'],
  ['Error: prompt too long', 'context_window_exceeded'],
  // F212 Phase D: CC tool-call parse failure (Claude CLI result error event)
  ["The model's tool call could not be parsed (retry also failed).", 'tool_call_parse_failed'],
  ['could not parse the model tool call after retry', 'tool_call_parse_failed'],
  ['Tool calls could not be parsed', 'tool_call_parse_failed'],
  // F212 Phase E (cloud codex P1 per @co-creator organic 2026-05-29): real CC text from screenshot.
  // Disambiguation signal: "(not your usage limit)" — MUST classify as server_overloaded,
  // NOT quota_exceeded. specific-first ordering protects the disambiguation.
  ['API Error: Server is temporarily limiting requests (not your usage limit) · Rate limited', 'server_overloaded'],
  ['529 Overloaded: anthropic temporarily limiting', 'server_overloaded'],
  ['Server is busy, please retry after 30 seconds', 'server_overloaded'],
  // Unknown — must return undefined
  ['some random weird thing happened', undefined],
  ['', undefined],
];

for (const [input, expected] of fixtures) {
  test(`classifies "${input.slice(0, 50)}" → ${expected ?? 'undefined'}`, () => {
    assert.strictEqual(classifyCliError(input), expected);
  });
}

test('classifies issue #777 reproducer (opencode NDJSON stream error)', () => {
  // AC-A8: stream error events also classify
  const input =
    'APIError: The supported API model names are deepseek-v4-pro or deepseek-v4-flash, but you passed deepseek-v-4.';
  assert.strictEqual(classifyCliError(input), 'model_not_found');
});

test('classifier is case-insensitive', () => {
  assert.strictEqual(classifyCliError('UNAUTHORIZED'), 'auth_failed');
  assert.strictEqual(classifyCliError('UNKNOWN MODEL'), 'model_not_found');
});

test('classifier returns first matching reasonCode (specific-first order)', () => {
  // Crafted input that could match multiple — must return most specific (first in pattern array)
  const input = 'model not found AND rate limit exceeded';
  // model_not_found comes before quota_exceeded in array
  assert.strictEqual(classifyCliError(input), 'model_not_found');
});
