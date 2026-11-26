import assert from 'node:assert/strict';
import { test } from 'node:test';
import { extractTranscriptUsage } from '../src/domains/cats/services/agents/providers/BgTranscriptEventConsumer.js';
import { extractClaudeUsage } from '../src/domains/cats/services/agents/providers/claude-ndjson-parser.js';
import { mergeTokenUsage } from '../src/domains/cats/services/types.js';

test('Claude cache warmth preserves the actual five-minute and one-hour write tiers', () => {
  const usage = extractClaudeUsage({
    usage: {
      input_tokens: 2,
      cache_read_input_tokens: 164458,
      cache_creation_input_tokens: 13243,
      output_tokens: 5,
      cache_creation: { ephemeral_1h_input_tokens: 13243, ephemeral_5m_input_tokens: 0 },
    },
  });
  assert.equal(usage.cacheCreation1hTokens, 13243);
  assert.equal(usage.cacheCreation5mTokens, 0);
  assert.equal(usage.inputTokens, 177703);
});

test('absent or invalid cache tiers stay unknown instead of fabricating one hour', () => {
  const missing = extractClaudeUsage({ usage: { input_tokens: 100 } });
  const invalid = extractClaudeUsage({ usage: { cache_creation: { ephemeral_1h_input_tokens: -1 } } });
  assert.equal(missing.cacheCreation1hTokens, undefined);
  assert.equal(missing.cacheCreation5mTokens, undefined);
  assert.equal(invalid.cacheCreation1hTokens, undefined);
});

test('cache-tier usage survives merged provider events without losing five-minute writes', () => {
  const first = extractClaudeUsage({ usage: { cache_creation: { ephemeral_1h_input_tokens: 300 } } });
  const second = extractClaudeUsage({ usage: { cache_creation: { ephemeral_5m_input_tokens: 70 } } });
  const merged = mergeTokenUsage(first, second);
  assert.equal(merged.cacheCreation1hTokens, 300);
  assert.equal(merged.cacheCreation5mTokens, 70);
});

test('the background transcript carrier preserves observed tiers through its synthetic terminal usage', () => {
  const usage = extractTranscriptUsage([
    {
      type: 'assistant',
      message: {
        model: 'sonnet',
        usage: {
          input_tokens: 2,
          cache_creation_input_tokens: 300,
          cache_creation: { ephemeral_1h_input_tokens: 250, ephemeral_5m_input_tokens: 50 },
        },
      },
    },
  ]);
  assert.equal(usage.cacheCreation1hTokens, 250);
  assert.equal(usage.cacheCreation5mTokens, 50);
});
