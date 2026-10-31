import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  accumulateMessageOutputText,
  accumulateMessageOutputTool,
  createMessageOutputState,
  materializeMessageOutput,
} from '../src/domains/cats/services/agents/message-output-accumulator.js';
import { safeParseExtra, serializeExtra } from '../src/domains/cats/services/stores/redis/redis-message-parsers.js';

const identity = { provider: 'codex', runtimeSessionId: 'native', turnId: 'turn' };
let state = createMessageOutputState({ threadId: 'thread', catId: 'codex61-sol', turnInvocationId: 'visible-child' });
state = accumulateMessageOutputText(state, {
  content: '过程。',
  outputMessage: { ...identity, nativeId: 'process', channel: 'commentary', complete: true },
});
state = accumulateMessageOutputTool(state, 'api-instance', 'visible-child');
state = accumulateMessageOutputText(state, {
  content: '回答。',
  outputMessage: { ...identity, nativeId: 'answer', channel: 'final', complete: true },
});
const snapshot = materializeMessageOutput(state);

test('the formal Redis extra whitelist retains exactly the API-born layout references', () => {
  const wire = serializeExtra({ outputLayout: snapshot.layout });
  assert.deepEqual(safeParseExtra(wire)?.outputLayout, snapshot.layout);
  assert.ok(!wire.includes('过程。') && !wire.includes('回答。'), 'the body stays solely in content');
});

test('malformed and unknown-version layout cannot become available after persistence', () => {
  for (const value of [{ ...snapshot.layout, v: 9 }, { ...snapshot.layout, content: 'second body' }, null, false]) {
    assert.equal(safeParseExtra(JSON.stringify({ outputLayout: value }))?.outputLayout, undefined);
  }
});
