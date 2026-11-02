import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NativeWatcherObservation } from '../../src/infrastructure/harness-eval/watcher-offline/native-observation.js';
import type { OfflineUsage } from '../../src/infrastructure/harness-eval/watcher-offline/usage.js';

const silent = {
  kind: 'silent',
  sourceIds: [],
  message: null,
  basis: null,
  recipient: null,
  ownerReason: null,
};

test('Claude output-only tool can finish, but any external tool declaration cancels the native call', () => {
  let cancelled = 0;
  const observation = new NativeWatcherObservation('anthropic', 'test-model', () => cancelled++);
  observation.observe({ type: 'system', subtype: 'init', tools: ['StructuredOutput'], mcp_servers: [] });
  observation.observe({
    type: 'assistant',
    message: { model: 'test-model', content: [{ type: 'tool_use', name: 'StructuredOutput', input: silent }] },
  });
  observation.observe({
    type: 'result',
    structured_output: silent,
    usage: { input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 10, output_tokens: 2 },
  });
  observation.observeMessage({ type: 'done' });
  const result = observation.finish(10, false);
  assert.equal(result.success, true);
  assert.equal(result.nativeToolSurface, 'output_only');
  assert.equal(result.usage[0].inputNew, 0);
  assert.equal(cancelled, 0);
  const unsafe = new NativeWatcherObservation('anthropic', 'test-model', () => cancelled++);
  unsafe.observe({ type: 'system', subtype: 'init', tools: ['StructuredOutput', 'Read'], mcp_servers: [] });
  assert.equal(cancelled, 1);
  assert.equal(unsafe.finish(10, true).nativeToolSurface, 'unexpected');
});

test('a later undeclared tool event also cancels; an unfamiliar Codex item cannot silently pass', () => {
  let cancelled = 0;
  const claude = new NativeWatcherObservation('anthropic', 'test-model', () => cancelled++);
  claude.observe({ type: 'system', subtype: 'init', tools: [], mcp_servers: [] });
  claude.observe({
    type: 'assistant',
    message: { model: 'test-model', content: [{ type: 'tool_use', name: 'Bash' }] },
  });
  const codex = new NativeWatcherObservation('openai', 'test-model', () => cancelled++);
  codex.observe({ type: 'item.started', item: { type: 'collab_tool_call' } });
  assert.equal(cancelled, 2);
});

test('a native model mismatch or missing usage remains a failure, with the response and spent usage retained', () => {
  const observation = new NativeWatcherObservation('openai', 'requested-model', () => {});
  observation.observe({ type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(silent) } });
  observation.observeMessage({ type: 'done', metadata: { servedModel: 'other-model' } });
  assert.equal(observation.finish(10, false).success, false);
  observation.observe({
    type: 'turn.completed',
    usage: { input_tokens: 12, cached_input_tokens: 0, output_tokens: 4 },
  });
  assert.equal(observation.finish(10, false).error, 'native_model_mismatch');
  assert.equal(observation.finish(10, false).usage[0].inputTotal, 12);
  observation.observeMessage({ type: 'done', metadata: { servedModel: 'requested-model' } });
  assert.equal(observation.finish(10, false).success, true);
});

function nativeResult(provider: OfflineUsage['provider'], usage: unknown) {
  const observation = new NativeWatcherObservation(provider, 'test-model', () => {});
  if (provider === 'anthropic') {
    observation.observe({ type: 'system', subtype: 'init', tools: ['StructuredOutput'], mcp_servers: [] });
    observation.observe({ type: 'result', structured_output: silent, usage });
  } else {
    observation.observe({ type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(silent) } });
    observation.observe({ type: 'turn.completed', usage });
  }
  observation.observeMessage({ type: 'done', metadata: { servedModel: 'test-model' } });
  return observation.finish(5, false);
}

for (const provider of ['openai', 'anthropic'] as const) {
  test(`${provider}: empty or entirely invalid token counters cannot pass native accounting`, () => {
    for (const raw of [
      {},
      {
        input_tokens: -1,
        output_tokens: '12',
        cached_input_tokens: NaN,
        cache_read_input_tokens: null,
        cache_creation_input_tokens: Infinity,
      },
    ]) {
      const result = nativeResult(provider, raw);
      assert.equal(result.success, false);
      assert.equal(result.error, 'native_usage_unobserved');
      assert.equal(result.usage.length, 1);
      assert.deepEqual(result.usage[0].native, {});
      assert.equal(result.usage[0].inputTotal, null);
    }
  });
  test(`${provider}: real all-zero usage is observed, and partial valid usage keeps missing fields unknown`, () => {
    const raw =
      provider === 'openai'
        ? { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0 }
        : { input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 0 };
    const zero = nativeResult(provider, raw);
    assert.equal(zero.success, true);
    assert.equal(zero.usage[0].inputTotal, 0);
    assert.equal(zero.usage[0].output, 0);
    const partial = nativeResult(provider, { input_tokens: 0 });
    assert.equal(partial.success, true);
    assert.equal(partial.usage[0].output, null);
    assert.equal(partial.usage[0].cacheRead, null);
  });
}
