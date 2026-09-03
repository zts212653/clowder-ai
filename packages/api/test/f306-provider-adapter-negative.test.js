import assert from 'node:assert/strict';
import { test } from 'node:test';

const [{ isProviderSemanticEvent }, { transformClaudeEvent }, { transformGeminiEvent }, acp] = await Promise.all([
  import('@cat-cafe/shared'),
  import('../dist/domains/cats/services/agents/providers/claude-ndjson-parser.js'),
  import('../dist/domains/cats/services/agents/providers/gemini-event-parser.js'),
  import('../dist/domains/cats/services/agents/providers/acp/acp-event-transformer.js'),
]);

const catId = 'codex';
const metadata = { provider: 'fixture', model: 'fixture' };

test('three non-Codex adapters stop provider wire types before the semantic-event contract', () => {
  const claudeWire = {
    type: 'stream_event',
    event: {
      type: 'content_block_delta',
      delta: { type: 'input_json_delta', partial_json: '{"method":"review/start"}' },
    },
  };
  const geminiWire = {
    type: 'review_start',
    review_mode: 'base_branch',
    target: 'origin/main',
  };
  const acpWire = {
    sessionId: 'acp-session-1',
    update: { sessionUpdate: 'current_mode_update', currentModeId: 'review' },
  };
  const adapted = [
    transformClaudeEvent(claudeWire, catId, {
      currentMessageId: undefined,
      partialTextMessageIds: new Set(),
      lastTurnInputTokens: undefined,
      thinkingBuffer: '',
    }),
    transformGeminiEvent(geminiWire, catId),
    acp.transformAcpEvent(acpWire, catId, metadata, acp.createAcpSessionState()),
  ];

  assert.deepEqual(adapted, [null, null, null]);
  for (const wire of [claudeWire, geminiWire, acpWire]) {
    assert.equal(isProviderSemanticEvent(wire), false);
  }
});
