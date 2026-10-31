import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  accumulateMessageOutputText,
  accumulateMessageOutputTool,
  createMessageOutputState,
  materializeMessageOutput,
} from '../src/domains/cats/services/agents/message-output-accumulator.js';

const owner = { threadId: 'thread', catId: 'codex61-sol', turnInvocationId: 'child' };
const native = (nativeId: string, channel = 'commentary', complete = true, textMode = 'replace') => ({
  provider: 'codex',
  runtimeSessionId: 'native',
  turnId: 'native-turn',
  nativeId,
  channel,
  complete,
  textMode,
});

test('the message-owned accumulator preserves native/tool order and owns only ranges of one body', () => {
  let state = createMessageOutputState(owner);
  state = accumulateMessageOutputText(state, { content: '过程。', outputMessage: native('process') });
  state = accumulateMessageOutputTool(state, 'api-tool-instance', 'child');
  state = accumulateMessageOutputText(state, {
    content: '\n\n回答。',
    outputMessage: { ...native('answer', 'final'), displayPrefixLength: 2 },
  });
  const result = materializeMessageOutput(state);
  assert.equal(result.content, '过程。\n\n回答。');
  assert.equal(result.layout?.status, 'available');
  if (result.layout?.status !== 'available') return;
  assert.deepEqual(result.layout.owner, owner);
  assert.deepEqual(
    result.layout.order.map((ref) => ref.kind),
    ['run', 'tool', 'run'],
  );
  assert.equal(result.layout.order[1].kind === 'tool' && result.layout.order[1].toolEventId, 'api-tool-instance');
  assert.deepEqual(
    result.layout.runs.map((run) => [run.start, run.end]),
    [
      [0, 3],
      [3, 8],
    ],
  );
  assert.ok(
    result.layout.runs.every((run) => !('text' in run)),
    'no second durable body',
  );
});

test('native append→replace updates its unsealed run without erasing earlier outputs or tools', () => {
  let state = createMessageOutputState(owner);
  state = accumulateMessageOutputText(state, { content: '过程。', outputMessage: native('process') });
  state = accumulateMessageOutputTool(state, 'tool', 'child');
  state = accumulateMessageOutputText(state, {
    content: '旧',
    outputMessage: native('answer', 'final', false, 'append'),
  });
  state = accumulateMessageOutputText(state, {
    content: '快照。',
    outputMessage: native('answer', 'final', false, 'append'),
  });
  state = accumulateMessageOutputText(state, {
    content: '新回答。',
    outputMessage: native('answer', 'final', true, 'replace'),
  });
  const result = materializeMessageOutput(state);
  assert.equal(result.content, '过程。\n\n新回答。');
  assert.equal(result.layout?.status, 'available');
});

test('unknown text around a real tool boundary stays whole but cannot enable classification', () => {
  let state = createMessageOutputState(owner);
  state = accumulateMessageOutputText(state, { content: '查前。' });
  state = accumulateMessageOutputTool(state, 'tool', 'child');
  state = accumulateMessageOutputText(state, { content: '' });
  state = accumulateMessageOutputText(state, { content: '查后。' });
  const result = materializeMessageOutput(state);
  assert.equal(result.content, '查前。\n\n查后。');
  assert.equal(result.layout?.status, 'unavailable');
});

test('an exact completed snapshot retry is idempotent, including tool references', () => {
  const input = { content: '回答。', outputMessage: native('answer', 'final') };
  let state = accumulateMessageOutputText(createMessageOutputState(owner), input);
  state = accumulateMessageOutputTool(state, 'tool', 'child');
  state = accumulateMessageOutputTool(state, 'tool', 'child');
  state = accumulateMessageOutputText(state, input);
  assert.equal(materializeMessageOutput(state).content, '回答。');
  assert.equal(materializeMessageOutput(state).layout.status, 'available');
});

for (const [name, later] of [
  ['complete then changed snapshot', { content: 'changed', outputMessage: native('answer', 'final') }],
  ['same identity with changed channel', { content: 'changed', outputMessage: native('answer', 'commentary') }],
] as const) {
  test(`${name} keeps public text but never enables classification`, () => {
    let state = accumulateMessageOutputText(createMessageOutputState(owner), {
      content: 'original',
      outputMessage: native('answer', 'final'),
    });
    state = accumulateMessageOutputText(state, later);
    const result = materializeMessageOutput(state);
    assert.ok(result.content.includes('original') && result.content.includes('changed'));
    assert.equal(result.layout.status, 'unavailable');
    assert.equal(result.layout.status === 'unavailable' && result.layout.reason, 'conflict');
  });
}

test('an intervening tool keeps a contradictory late replacement readable as a conflict', () => {
  let state = accumulateMessageOutputText(createMessageOutputState(owner), {
    content: 'original',
    outputMessage: native('answer', 'final', false),
  });
  state = accumulateMessageOutputTool(state, 'tool', 'child');
  state = accumulateMessageOutputText(state, { content: 'changed', outputMessage: native('answer', 'final') });
  const result = materializeMessageOutput(state);
  assert.equal(result.content, 'original\n\nchanged');
  assert.equal(result.layout.status === 'unavailable' && result.layout.reason, 'conflict');
});

for (const channel of [undefined, 'final'] as const) {
  test(`late tool results do not split an unfinished native item (${channel ?? 'unknown'} channel)`, () => {
    let state = createMessageOutputState(owner);
    const chunks = ['第一段', '已', '转', '绿'];
    for (const [index, content] of chunks.entries()) {
      state = accumulateMessageOutputText(state, {
        content,
        outputMessage: { ...native('answer', 'final', false, 'append'), channel },
      });
      if (index < 2) state = accumulateMessageOutputTool(state, `result-${index}`, 'child');
      assert.equal(materializeMessageOutput(state).content, chunks.slice(0, index + 1).join(''));
    }
    const completion = { content: '第一段已转绿', outputMessage: native('answer', 'final') };
    state = accumulateMessageOutputText(state, completion);
    state = accumulateMessageOutputText(state, completion);
    const result = materializeMessageOutput(state);
    assert.equal(result.content, completion.content);
    assert.equal(result.layout.status, 'available');
    if (result.layout.status !== 'available') return;
    assert.deepEqual(
      result.layout.order.map((ref) => ref.kind),
      ['run', 'tool', 'tool'],
    );
    assert.deepEqual(
      result.layout.runs.map((run) => [run.start, run.end]),
      [[0, completion.content.length]],
    );
  });
}

test('a prefix-preserving completion can finish a native item after a tool without losing characters', () => {
  let state = accumulateMessageOutputText(createMessageOutputState(owner), {
    content: '开头',
    outputMessage: native('answer', 'final', false, 'append'),
  });
  state = accumulateMessageOutputTool(state, 'result', 'child');
  state = accumulateMessageOutputText(state, {
    content: '开头和完成内容。',
    outputMessage: native('answer', 'final'),
  });
  assert.equal(materializeMessageOutput(state).content, '开头和完成内容。');
  assert.equal(materializeMessageOutput(state).layout.status, 'available');
});

test('an observed own-signature suffix may be removed at native completion across a tool', () => {
  const suffix = '\n\n[小太阳/gpt-6.1-sol🐾]';
  let state = accumulateMessageOutputText(createMessageOutputState(owner), {
    content: '结论一',
    outputMessage: native('answer', 'final', false, 'append'),
  });
  state = accumulateMessageOutputTool(state, 'result', 'child');
  state = accumulateMessageOutputText(state, {
    content: `\n\n结论二${suffix}`,
    outputMessage: native('answer', 'final', false, 'append'),
  });
  state = accumulateMessageOutputText(state, {
    content: '结论一\n\n结论二',
    outputMessage: native('answer', 'final'),
    nativeSignatureSuffix: suffix,
  });
  assert.equal(materializeMessageOutput(state).content, '结论一\n\n结论二');
  assert.equal(materializeMessageOutput(state).layout.status, 'available');
});

for (const [removed, nativeSignatureSuffix] of [
  ['不能丢的正文', undefined],
  ['\n\n[示例/gpt-6.1-sol🐾]', undefined],
  ['不能丢的正文\n\n[小太阳/gpt-6.1-sol🐾]', '\n\n[小太阳/gpt-6.1-sol🐾]'],
] as const) {
  test(`an unproven shorter completion across tools cannot discard content (${removed})`, () => {
    let state = accumulateMessageOutputText(createMessageOutputState(owner), {
      content: `开头${removed}`,
      outputMessage: native('answer', 'final', false, 'append'),
    });
    state = accumulateMessageOutputTool(state, 'result', 'child');
    state = accumulateMessageOutputText(state, {
      content: '开头',
      outputMessage: native('answer', 'final'),
      nativeSignatureSuffix,
    });
    const result = materializeMessageOutput(state);
    assert.equal(result.content, `开头${removed}\n\n开头`);
    assert.equal(result.layout.status === 'unavailable' && result.layout.reason, 'conflict');
  });
}

test('a conflicting native channel keeps both texts while later fragments finish only their own run', () => {
  let state = accumulateMessageOutputText(createMessageOutputState(owner), {
    content: '原文',
    outputMessage: native('answer', 'final', false, 'append'),
  });
  state = accumulateMessageOutputTool(state, 'result', 'child');
  for (const content of ['冲', '突'])
    state = accumulateMessageOutputText(state, {
      content,
      outputMessage: native('answer', 'commentary', false, 'append'),
    });
  const completion = { content: '冲突', outputMessage: native('answer', 'commentary') };
  state = accumulateMessageOutputText(state, completion);
  state = accumulateMessageOutputText(state, completion);
  const result = materializeMessageOutput(state);
  assert.equal(result.content, '原文\n\n冲突');
  assert.equal(result.layout.status === 'unavailable' && result.layout.reason, 'conflict');
});

test('completed snapshots stay idempotent when retries alternate between two conflicting observations', () => {
  const original = { content: '原文', outputMessage: native('answer', 'final') };
  const changed = { content: '改文', outputMessage: native('answer', 'final') };
  let state = accumulateMessageOutputText(createMessageOutputState(owner), original);
  state = accumulateMessageOutputText(state, changed);
  for (const completion of [original, changed, original, changed])
    state = accumulateMessageOutputText(state, completion);
  const result = materializeMessageOutput(state);
  assert.equal(result.content, '原文\n\n改文');
  assert.equal(result.layout.status === 'unavailable' && result.layout.reason, 'conflict');
});

test('an intervening native text seals the previous item even when a late snapshot preserves its prefix', () => {
  let state = accumulateMessageOutputText(createMessageOutputState(owner), {
    content: '先前',
    outputMessage: native('earlier', 'commentary', false, 'append'),
  });
  state = accumulateMessageOutputText(state, { content: '之后', outputMessage: native('answer', 'final') });
  state = accumulateMessageOutputText(state, {
    content: '先前完整',
    outputMessage: native('earlier', 'commentary'),
  });
  const result = materializeMessageOutput(state);
  assert.equal(result.content, '先前\n\n之后\n\n先前完整');
  assert.equal(result.layout.status === 'unavailable' && result.layout.reason, 'conflict');
});

test('oversized native tool history cannot insert paragraph boundaries into later deltas', () => {
  let state = accumulateMessageOutputText(createMessageOutputState(owner), {
    content: '长回话',
    outputMessage: native('answer', 'final', false, 'append'),
  });
  for (let index = 0; index < 1153; index++) state = accumulateMessageOutputTool(state, `tool-${index}`, 'child');
  for (const content of ['仍', '然', '连', '续']) {
    state = accumulateMessageOutputText(state, {
      content,
      outputMessage: native('answer', 'final', false, 'append'),
    });
  }
  state = accumulateMessageOutputText(state, {
    content: '长回话仍然连续',
    outputMessage: native('answer', 'final'),
  });
  const result = materializeMessageOutput(state);
  assert.equal(result.content, '长回话仍然连续');
  assert.equal(result.layout.status === 'unavailable' && result.layout.reason, 'oversized');
  assert.deepEqual(
    state.entries.filter((entry) => entry.kind === 'tool').map((entry) => entry.toolEventId),
    Array.from({ length: 1153 }, (_, index) => `tool-${index}`),
  );
});

for (const mode of [null, 'bogus', {}, 0, false]) {
  test(`invalid explicit native mode ${JSON.stringify(mode)} preserves body and fails closed`, () => {
    const state = accumulateMessageOutputText(createMessageOutputState(owner), {
      content: 'do not hide',
      outputMessage: { ...native('answer', 'final'), textMode: mode },
    });
    const result = materializeMessageOutput(state);
    assert.equal(result.content, 'do not hide');
    assert.equal(result.layout.status === 'unavailable' && result.layout.reason, 'conflict');
  });
}

test('native mode never borrows the outer whole-bubble replace mode', () => {
  let state = accumulateMessageOutputText(createMessageOutputState(owner), {
    content: '前',
    outputMessage: native('answer', 'final', false, 'append'),
  });
  state = accumulateMessageOutputText(state, {
    content: '后。',
    textMode: 'replace',
    outputMessage: { ...native('answer', 'final'), textMode: undefined },
  });
  assert.equal(materializeMessageOutput(state).content, '前后。');
  const roundTrip = JSON.parse(JSON.stringify(state));
  assert.deepEqual(materializeMessageOutput(roundTrip), materializeMessageOutput(state));
});

test('genuine legacy whole-body replacement resets content and invalidates layout', () => {
  let state = accumulateMessageOutputText(createMessageOutputState(owner), {
    content: 'old',
    outputMessage: native('answer', 'final'),
  });
  state = accumulateMessageOutputText(state, { content: 'canonical replacement', textMode: 'replace' });
  const result = materializeMessageOutput(state);
  assert.equal(result.content, 'canonical replacement');
  assert.equal(result.layout.status === 'unavailable' && result.layout.reason, 'whole_body_replaced');
});

test('surrogate fragments normalize only the published snapshot and keep UTF-16 ranges', () => {
  let state = accumulateMessageOutputText(createMessageOutputState(owner), {
    content: '\uD83D',
    outputMessage: native('answer', 'final', false, 'append'),
  });
  assert.equal(materializeMessageOutput(state).content, '\uFFFD');
  state = accumulateMessageOutputText(state, {
    content: '\uDE3A。',
    outputMessage: native('answer', 'final', true, 'append'),
  });
  const result = materializeMessageOutput(state);
  assert.equal(result.content, '😺。');
  assert.equal(result.layout.contentRevision.length, 3);
  assert.equal(result.layout.status === 'available' && result.layout.runs[0].end, 3);
});

for (const suffix of ['', '\n', '\n\n']) {
  test(`a tool separator adds only missing blank lines (${suffix.length})`, () => {
    let state = accumulateMessageOutputText(createMessageOutputState(owner), { content: `before${suffix}` });
    state = accumulateMessageOutputTool(state, 'use', 'child');
    state = accumulateMessageOutputTool(state, 'result', 'child');
    state = accumulateMessageOutputText(state, { content: 'after' });
    assert.equal(materializeMessageOutput(state).content, 'before\n\nafter');
  });
}

test('a genuine empty whole-body replacement is not ignored as an empty fragment', () => {
  let state = accumulateMessageOutputText(createMessageOutputState(owner), { content: 'old whole body' });
  state = accumulateMessageOutputText(state, { content: '', textMode: 'replace' });
  assert.equal(materializeMessageOutput(state).content, '');
});

test('an event instance reused by a different execution invalidates its order evidence', () => {
  let state = accumulateMessageOutputText(createMessageOutputState(owner), {
    content: 'answer',
    outputMessage: native('answer', 'final'),
  });
  state = accumulateMessageOutputTool(state, 'instance', 'child');
  state = accumulateMessageOutputTool(state, 'instance', 'other-child');
  assert.equal(materializeMessageOutput(state).layout.status, 'unavailable');
});

test('an explicitly malformed completion observation cannot later acquire complete evidence', () => {
  let state = accumulateMessageOutputText(createMessageOutputState(owner), {
    content: 'old',
    outputMessage: { ...native('answer', 'final'), complete: 'true' },
  });
  state = accumulateMessageOutputText(state, { content: 'new', outputMessage: native('answer', 'final') });
  const result = materializeMessageOutput(state);
  assert.equal(result.layout.status === 'unavailable' && result.layout.reason, 'conflict');
});
