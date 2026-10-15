import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCatId } from '@cat-cafe/shared';
import { transformClaudeEvent } from '../src/domains/cats/services/agents/providers/claude-ndjson-parser.js';

const catId = createCatId('opus');
const state = () => ({
  currentMessageId: undefined,
  partialTextMessageIds: new Set<string>(),
  lastTurnInputTokens: undefined,
  thinkingBuffer: '',
});
function start(id: string, name = 'Read', parent?: string) {
  return {
    type: 'assistant',
    parent_tool_use_id: parent,
    message: { content: [{ type: 'tool_use', id, name, input: { file_path: `${name}.txt` } }] },
  };
}
function finish(id: string, content: unknown, isError: boolean | undefined = false, parent?: string) {
  return {
    type: 'user',
    parent_tool_use_id: parent,
    message: { content: [{ type: 'tool_result', tool_use_id: id, content, is_error: isError }] },
  };
}
function messages(raw: unknown, parserState: ReturnType<typeof state>) {
  const result = transformClaudeEvent(raw, catId, parserState);
  return result ? (Array.isArray(result) ? result : [result]) : [];
}
for (const isError of [false, true]) {
  test(`native user/tool_result carries ID, ${isError ? 'failure' : 'success'} and result`, () => {
    const parserState = state();
    messages(start('call-1'), parserState);
    const results = messages(finish('call-1', 'native result sentinel', isError), parserState);
    assert.equal(results.length, 1);
    assert.equal(results[0].type, 'tool_result');
    assert.equal(results[0].toolUseId, 'call-1');
    assert.equal(results[0].toolName, 'Read');
    assert.equal(results[0].toolResultStatus, isError ? 'error' : 'ok');
    assert.equal(results[0].content, 'native result sentinel');
    assert.deepEqual(results[0].toolInput, { file_path: 'Read.txt' });
  });
}
test('parallel results arriving in reverse order retain their own native inputs and names', () => {
  const parserState = state();
  messages(start('read', 'Read'), parserState);
  messages(start('grep', 'Grep'), parserState);
  const results = [
    ...messages(finish('grep', 'grep output'), parserState),
    ...messages(finish('read', 'read output'), parserState),
  ];
  assert.deepEqual(
    results.map((result) => [result.toolUseId, result.toolName, result.toolInput]),
    [
      ['grep', 'Grep', { file_path: 'Grep.txt' }],
      ['read', 'Read', { file_path: 'Read.txt' }],
    ],
  );
});
test('parent scope prevents a child result with the same native ID from consuming a root call', () => {
  const parserState = state();
  messages(start('same', 'RootRead'), parserState);
  const childStart = messages(start('same', 'ChildRead', 'agent-1'), parserState)[0];
  assert.equal((childStart as unknown as Record<string, unknown>).toolParentUseId, 'agent-1');
  const child = messages(finish('same', 'child output', false, 'agent-1'), parserState)[0];
  const root = messages(finish('same', 'root output'), parserState)[0];
  assert.equal(child.toolName, 'ChildRead');
  assert.equal((child as unknown as Record<string, unknown>).toolParentUseId, 'agent-1');
  assert.equal(root.toolName, 'RootRead');
});
test('structured native result content survives independently of its textual preview', () => {
  const parserState = state();
  const content = [
    { type: 'text', text: 'image result' },
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'synthetic-base64' } },
  ];
  messages(start('image'), parserState);
  const result = messages(finish('image', content), parserState)[0];
  assert.ok(result);
  assert.match(result.content ?? '', /image result/);
  assert.deepEqual((result as unknown as Record<string, unknown>).toolRawPayload, {
    rawInput: { file_path: 'Read.txt' },
    rawOutput: content,
    content,
  });
});
test('duplicate terminal tool results do not duplicate history, but distinct calls still emit', () => {
  const parserState = state();
  messages(start('call-1'), parserState);
  assert.equal(messages(finish('call-1', 'output'), parserState).length, 1);
  assert.equal(messages(finish('call-1', 'output'), parserState).length, 0);
  messages(start('call-2'), parserState);
  assert.equal(messages(finish('call-2', 'output'), parserState).length, 1);
});
test('orphan results preserve native facts without inventing a name or input', () => {
  const results = messages(finish('orphan', 'result', undefined), state());
  assert.equal(results.length, 1);
  assert.equal(results[0].toolUseId, 'orphan');
  assert.equal(results[0].toolName, undefined);
  assert.equal(results[0].toolInput, undefined);
});
test('a new native session clears prior tool pairing facts', () => {
  const parserState = state();
  messages(start('reuse', 'OldName'), parserState);
  messages({ type: 'system', subtype: 'init', session_id: 'new-session' }, parserState);
  const result = messages(finish('reuse', 'new-session result'), parserState)[0];
  assert.ok(result);
  assert.equal(result.toolName, undefined);
});
test('ordinary user input and malformed result blocks stay outside tool results', () => {
  const parserState = state();
  assert.deepEqual(
    messages({ type: 'user', message: { content: [{ type: 'text', text: 'human prompt' }] } }, parserState),
    [],
  );
  assert.deepEqual(
    messages(
      { type: 'user', message: { content: [null, { type: 'tool_result', content: 'missing native ID' }] } },
      parserState,
    ),
    [],
  );
});
