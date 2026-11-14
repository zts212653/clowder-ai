import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WatcherTokenUsage } from '../dist/domains/cats/services/agents/providers/CodexAppServerWatcherUsage.js';

test('usage includes every tool continuation, excludes prior native turns, and does not double count repeated notifications', () => {
  const usage = new WatcherTokenUsage();
  const event = (total) => ({
    total: { inputTokens: total, outputTokens: total / 10, cachedInputTokens: total / 2 },
    last: { inputTokens: 10, outputTokens: 1, cachedInputTokens: 5 },
  });
  usage.observe(event(110));
  usage.observe(event(110));
  usage.observe(event(120));
  usage.observe(event(170));
  assert.deepEqual(usage.value(), { input_tokens: 70, output_tokens: 7, cached_input_tokens: 35 });
});
test('missing provider values remain missing rather than a fabricated zero or an unrelated lifetime total', () => {
  const usage = new WatcherTokenUsage();
  usage.observe({ last: { inputTokens: 10 }, total: { inputTokens: 110 } });
  assert.deepEqual(usage.value(), { input_tokens: 10 });
});

test('a cache field absent at the first request remains unknown for the whole turn', () => {
  const usage = new WatcherTokenUsage();
  usage.observe({ last: { inputTokens: 10 }, total: { inputTokens: 110 } });
  usage.observe({
    last: { inputTokens: 10, cachedInputTokens: 5 },
    total: { inputTokens: 120, cachedInputTokens: 65 },
  });
  assert.deepEqual(usage.value(), { input_tokens: 20 });
});
