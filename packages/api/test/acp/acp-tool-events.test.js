import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  createAcpSessionState,
  transformAcpEvent,
} from '../../dist/domains/cats/services/agents/providers/acp/acp-event-transformer.js';

const metadata = { provider: 'acp', model: 'dsh-profile' };
const event = (update, state) => transformAcpEvent({ sessionId: 'dsh-session', update }, 'dsh', metadata, state);
const text = (value) => ({ type: 'content', content: { type: 'text', text: value } });
const begin = (state, id = 'call-1', rawInput = { command: 'echo ok' }) =>
  event({ sessionUpdate: 'tool_call', toolCallId: id, title: 'bash', status: 'in_progress', rawInput }, state);
const finish = (state, update = {}) =>
  event({ sessionUpdate: 'tool_call_update', toolCallId: 'call-1', status: 'completed', ...update }, state);

describe('ACP standard tool payloads (DSH wire fixtures)', () => {
  it('preserves standard object input and native id, ahead of legacy aliases', () => {
    const input = { command: 'echo ok', cwd: '/workspace', timeout: 0 };
    const result = event(
      {
        sessionUpdate: 'tool_call',
        toolCallId: 'call-1',
        title: 'bash',
        status: 'in_progress',
        rawInput: input,
        toolInput: { command: 'wrong alias' },
      },
      createAcpSessionState(),
    );
    assert.deepEqual(result.toolInput, input);
    assert.equal(result.toolUseId, 'call-1');
    assert.deepEqual(result.toolRawPayload.rawInput, input);
  });

  for (const input of ['{broken json', [1, 'two'], 0, false]) {
    it(`retains opaque input ${JSON.stringify(input)} without pretending it is an object`, () => {
      const result = begin(createAcpSessionState(), 'opaque', input);
      assert.deepEqual(result.toolInput, { rawInput: input });
      assert.deepEqual(result.toolRawPayload.rawInput, input);
    });
  }

  for (const [status, expected] of [
    ['completed', 'ok'],
    ['failed', 'error'],
  ]) {
    it(`pairs a ${status} DSH result array without a repeated title`, () => {
      const state = createAcpSessionState();
      begin(state);
      const content = [text('first line'), text('second line')];
      const result = finish(state, { status, content });
      assert.equal(result.type, 'tool_result');
      assert.equal(result.toolName, 'bash');
      assert.equal(result.toolUseId, 'call-1');
      assert.equal(result.toolResultStatus, expected);
      assert.equal(result.content, 'first line\nsecond line');
      assert.deepEqual(result.toolRawPayload.content, content);
      assert.deepEqual(result.toolRawPayload.rawInput, { command: 'echo ok' });
      assert.equal(finish(state, { status, content }), null);
    });
  }

  it('keeps same-name parallel calls and separate sessions isolated', () => {
    const state = createAcpSessionState(),
      other = createAcpSessionState();
    begin(state, 'first', { command: 'one' });
    begin(state, 'second', { command: 'two' });
    event({ sessionUpdate: 'tool_call', toolCallId: 'first', title: 'read_file', rawInput: { path: '/other' } }, other);
    const second = finish(state, { toolCallId: 'second', content: [text('two')] });
    const first = finish(state, { toolCallId: 'first', content: [text('one')] });
    const isolated = finish(other, { toolCallId: 'first', content: [text('other')] });
    assert.equal(second.toolUseId, 'second');
    assert.equal(first.toolUseId, 'first');
    assert.deepEqual(second.toolRawPayload.rawInput, { command: 'two' });
    assert.deepEqual(first.toolRawPayload.rawInput, { command: 'one' });
    assert.equal(isolated.toolName, 'read_file');
  });

  it('merges optional progress fields, retains explicit raw null, and emits no extra pending call', () => {
    const state = createAcpSessionState();
    begin(state);
    const content = [text('progress result')];
    assert.equal(
      event(
        {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'call-1',
          name: 'shell',
          rawInput: null,
          status: 'in_progress',
          content,
        },
        state,
      ),
      null,
    );
    const result = finish(state);
    assert.equal(result.toolName, 'shell');
    assert.equal(result.content, 'progress result');
    assert.equal(result.toolRawPayload.rawInput, null);
    assert.deepEqual(result.toolRawPayload.content, content);
  });

  it('does not re-emit a replayed pending event or a pending event after final', () => {
    const state = createAcpSessionState();
    begin(state);
    assert.equal(begin(state), null);
    finish(state);
    assert.equal(begin(state), null);
  });

  it('keeps a programmatic name when a progress update changes only the display title', () => {
    const state = createAcpSessionState();
    event({ sessionUpdate: 'tool_call', toolCallId: 'call-1', name: 'read_file', title: 'Reading a.ts' }, state);
    event({ sessionUpdate: 'tool_call_update', toolCallId: 'call-1', title: 'Finished reading a.ts' }, state);
    assert.equal(finish(state).toolName, 'read_file');
  });

  it('completes an empty result and records failure independently of its text', () => {
    const state = createAcpSessionState();
    begin(state);
    const result = finish(state, { status: 'failed', content: [] });
    assert.equal(result.content, '');
    assert.equal(result.toolResultStatus, 'error');
    assert.deepEqual(result.toolRawPayload.content, []);
    const misleading = finish(createAcpSessionState(), { content: [text('error word in a successful response')] });
    assert.equal(misleading[1].toolResultStatus, 'ok');
  });

  it('synthesizes a correlated pair if the first observation is final, without inventing a tool name', () => {
    const pair = finish(createAcpSessionState(), { status: 'failed', rawInput: 'opaque', content: [text('failed')] });
    assert.deepEqual(
      pair.map((msg) => msg.type),
      ['tool_use', 'tool_result'],
    );
    assert.equal(pair[0].toolUseId, 'call-1');
    assert.equal(pair[1].toolUseId, 'call-1');
    assert.equal(pair[0].toolName, undefined);
    assert.deepEqual(pair[0].toolInput, { rawInput: 'opaque' });
    assert.equal(pair[1].toolResultStatus, 'error');
  });

  it('preserves diff/resource/media/unknown blocks separately from their display summary', () => {
    const content = [
      text('summary'),
      { type: 'diff', path: '/workspace/a.ts', oldText: 'before', newText: 'after' },
      { type: 'content', content: { type: 'resource_link', uri: 'file:///workspace/a.ts', name: 'a.ts' } },
      { type: 'content', content: { type: 'image', mimeType: 'image/png', data: 'binary-payload' } },
      { type: 'terminal', terminalId: 'terminal-1' },
      { type: 'future-block', custom: { value: 42 } },
    ];
    const state = createAcpSessionState();
    begin(state);
    const result = finish(state, { content });
    assert.deepEqual(result.toolRawPayload.content, content);
    assert.match(result.content, /summary/);
    for (const marker of ['diff', '/workspace/a.ts', 'resource_link', 'image', 'terminal', 'future-block'])
      assert.ok(result.content.includes(marker), marker);
    assert.doesNotMatch(result.content, /binary-payload/);
    assert.match(result.content, /not rendered|unavailable|unsupported/i);
  });

  for (const output of ['raw result', { answer: 42 }, [1, 2], false, 0]) {
    it(`supports rawOutput ${JSON.stringify(output)} when content is absent`, () => {
      const pair = finish(createAcpSessionState(), { rawOutput: output });
      const result = pair[1];
      assert.deepEqual(result.toolRawPayload.rawOutput, output);
      assert.equal(result.content, typeof output === 'string' ? output : JSON.stringify(output));
    });
  }

  it('preserves legacy flat content and input aliases', () => {
    const pair = event(
      {
        sessionUpdate: 'tool_call',
        toolCallId: 'legacy',
        tool_name: 'legacy_tool',
        tool_input: { path: '/legacy' },
        status: 'completed',
        content: { type: 'text', text: 'legacy result' },
      },
      createAcpSessionState(),
    );
    assert.deepEqual(pair[0].toolInput, { path: '/legacy' });
    assert.equal(pair[1].content, 'legacy result');
    assert.equal(pair[1].toolUseId, 'legacy');
  });
});
