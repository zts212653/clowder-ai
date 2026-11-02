import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readOfflineUsage, sumOfflineCalls } from '../../src/infrastructure/harness-eval/watcher-offline/usage.js';

test('Claude zero new input and zero cache-read remain observations, not missing fields', () => {
  const raw = { input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 45, output_tokens: 8 };
  assert.deepEqual(readOfflineUsage('anthropic', { type: 'result', usage: raw, total_cost_usd: 0 }), {
    provider: 'anthropic',
    inputTotal: 45,
    inputNew: 0,
    cacheRead: 0,
    cacheWrite: 45,
    output: 8,
    reportedCostUsd: 0,
    native: raw,
  });
});

test('Codex input includes cache and is not added to cache again', () => {
  const raw = { input_tokens: 1000, cached_input_tokens: 800, output_tokens: 7 };
  assert.deepEqual(readOfflineUsage('openai', { type: 'turn.completed', usage: raw }), {
    provider: 'openai',
    inputTotal: 1000,
    inputNew: 200,
    cacheRead: 800,
    cacheWrite: null,
    output: 7,
    reportedCostUsd: null,
    native: raw,
  });
});

test('partial native usage does not invent a zero or a total; unrelated events have no usage', () => {
  const result = readOfflineUsage('anthropic', { type: 'result', usage: { input_tokens: 12 } });
  assert.equal(result?.inputNew, 12);
  assert.equal(result?.cacheRead, null);
  assert.equal(result?.inputTotal, null);
  assert.equal(readOfflineUsage('openai', { type: 'item.completed', item: {} }), null);
});

test('multi-stage totals keep a missing failed attempt unknown instead of undercounting cost', () => {
  const usage = readOfflineUsage('openai', {
    type: 'turn.completed',
    usage: { input_tokens: 100, cached_input_tokens: 20, output_tokens: 3 },
  });
  assert.ok(usage);
  const calls = [
    { usage: [usage], elapsedMs: 10 },
    { usage: [usage], elapsedMs: 20 },
  ];
  assert.deepEqual(sumOfflineCalls(calls), {
    inputTotal: 200,
    inputNew: 160,
    cacheRead: 40,
    cacheWrite: null,
    output: 6,
    reportedCostUsd: null,
    elapsedMs: 30,
  });
  const incomplete = sumOfflineCalls([...calls, { usage: [], elapsedMs: 5 }]);
  assert.equal(incomplete.inputTotal, null);
  assert.equal(incomplete.output, null);
  assert.equal(incomplete.elapsedMs, 35);
  assert.equal(sumOfflineCalls([]).inputTotal, null);
});
