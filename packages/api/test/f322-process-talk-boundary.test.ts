import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  accumulateMessageOutputText,
  accumulateMessageOutputTool,
  createMessageOutputState,
  materializeMessageOutput,
} from '../src/domains/cats/services/agents/message-output-accumulator.js';

const owner = { threadId: 'thread', catId: 'opus55', turnInvocationId: 'turn' };
const success = { succeeded: true, nativePhases: false };

function example() {
  let state = createMessageOutputState(owner);
  state = accumulateMessageOutputText(state, { content: '不用你做什么，已经接上了。' });
  state = accumulateMessageOutputTool(state, 'read', 'turn');
  state = accumulateMessageOutputText(state, { content: '中间也有完整答复。' });
  state = accumulateMessageOutputTool(state, 'write', 'turn');
  return accumulateMessageOutputText(state, { content: '两件事现在都接上了。' });
}

test('successful non-native turn preserves early complete answers and attests the last tool boundary', () => {
  const before = materializeMessageOutput(example());
  const after = materializeMessageOutput(example(), success);
  assert.equal(after.content, before.content);
  assert.equal(after.content, '不用你做什么，已经接上了。\n\n中间也有完整答复。\n\n两件事现在都接上了。');
  assert.equal(after.layout.status, 'available');
  assert.equal(after.layout.basis, 'successful_turn_last_tool');
  assert.deepEqual(
    after.layout.runs.map((run) => run.channel),
    ['commentary', 'commentary', 'final'],
  );
  assert.equal(
    after.layout.runs.some((run) => 'identity' in run),
    false,
  );
  assert.deepEqual(
    after.layout.order.map((ref) => ref.kind),
    ['run', 'tool', 'run', 'tool', 'run'],
  );
});

test('streaming, failed/cancelled and native-phase turns never acquire a tool boundary', () => {
  for (const settlement of [undefined, { ...success, succeeded: false }, { ...success, nativePhases: true }]) {
    assert.equal(materializeMessageOutput(example(), settlement).layout.status, 'unavailable');
  }
});

test('no tools is whole answer and a whole-body replacement cannot invent an earlier boundary', () => {
  const plain = accumulateMessageOutputText(createMessageOutputState(owner), { content: '完整答复。' });
  assert.equal(materializeMessageOutput(plain, success).content, '完整答复。');
  assert.equal(materializeMessageOutput(plain, success).layout.basis, undefined);
  const replaced = accumulateMessageOutputText(example(), { content: '整体新正文', textMode: 'replace' });
  assert.equal(materializeMessageOutput(replaced, success).layout.status, 'unavailable');
});

test('a final read-only tool with no following answer leaves the whole reply visible', () => {
  const state = accumulateMessageOutputTool(example(), 'last', 'turn');
  assert.equal(materializeMessageOutput(state, success).layout.status, 'unavailable');
});
