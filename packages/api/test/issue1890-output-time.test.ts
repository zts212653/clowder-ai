import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  accumulateMessageOutputText,
  accumulateMessageOutputTool,
  createMessageOutputState,
  materializeMessageOutput,
} from '../src/domains/cats/services/agents/message-output-accumulator.js';

const owner = { threadId: 'thread', catId: 'codex', turnInvocationId: 'child' };
const native = (complete: boolean, textMode: 'append' | 'replace') => ({
  provider: 'codex',
  runtimeSessionId: 'session',
  turnId: 'turn',
  nativeId: 'answer',
  channel: 'final',
  complete,
  textMode,
});

test('a native speech run keeps its first host observation across streaming, completion and replay', () => {
  let state = accumulateMessageOutputText(createMessageOutputState(owner), {
    content: '审查',
    outputMessage: native(false, 'append'),
    observedAt: 3_000,
  });
  state = accumulateMessageOutputText(state, {
    content: '审查已通过。',
    outputMessage: native(true, 'replace'),
    observedAt: 4_000,
  });
  state = accumulateMessageOutputText(state, {
    content: '审查已通过。',
    outputMessage: native(true, 'replace'),
    observedAt: 5_000,
  });
  const result = materializeMessageOutput(state);
  assert.equal(result.content, '审查已通过。');
  assert.equal(result.layout.status, 'available');
  if (result.layout.status !== 'available') return;
  assert.equal(result.layout.runs[0].observedAt, 3_000);
  assert.equal(result.layout.runs.length, 1);
});

test('a generic carrier retains observed speech ranges around a real context-read tool', () => {
  let state = accumulateMessageOutputText(createMessageOutputState(owner), {
    content: '请审查。',
    observedAt: 1_000,
  });
  state = accumulateMessageOutputTool(state, 'context-read', owner.turnInvocationId);
  state = accumulateMessageOutputText(state, { content: '已收到审查，提交完成。', observedAt: 3_000 });
  const result = materializeMessageOutput(state, { succeeded: true, nativePhases: false });
  assert.equal(result.layout.status, 'available');
  if (result.layout.status !== 'available') return;
  assert.deepEqual(
    result.layout.runs.map((run) => ({ text: result.content.slice(run.start + run.gluePrefixLength, run.end), at: run.observedAt })),
    [{ text: '请审查。', at: 1_000 }, { text: '已收到审查，提交完成。', at: 3_000 }],
  );
});
