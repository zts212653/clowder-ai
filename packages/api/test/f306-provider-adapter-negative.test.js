import assert from 'node:assert/strict';
import { test } from 'node:test';

const [{ isProviderSemanticEvent }, { transformClaudeEvent }, { parseAgyStreamJsonLine }, acp] = await Promise.all([
  import('@cat-cafe/shared'),
  import('../dist/domains/cats/services/agents/providers/claude-ndjson-parser.js'),
  import('../dist/domains/cats/services/agents/providers/agy-stream-json-parser.js'),
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
    event: 'review_start',
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
    parseAgyStreamJsonLine(JSON.stringify(geminiWire)),
    acp.transformAcpEvent(acpWire, catId, metadata, acp.createAcpSessionState()),
  ];

  assert.equal(adapted[0], null);
  assert.equal(adapted[1].kind, 'unknown');
  assert.equal(isProviderSemanticEvent(adapted[1]), false);
  assert.equal(adapted[2], null);
  for (const wire of [claudeWire, geminiWire, acpWire]) {
    assert.equal(isProviderSemanticEvent(wire), false);
  }
});
