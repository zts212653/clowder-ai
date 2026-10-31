import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runNativeAuthContinuation as run } from './helpers/native-auth-continuation-fixture.js';

const ambiguous = [
  ['tool error object without message', { doneToolInfo: { error: { code: 'UNKNOWN_TOOL_RESULT' } } }],
  ['tool error string', { doneToolInfo: { error: 'tool effect outcome unavailable' } }],
  ['tool error empty object', { doneToolInfo: { error: {} } }],
  ['tool error non-string message', { doneToolInfo: { error: { message: 17 } } }],
  ['tool error blank message', { doneToolInfo: { error: { message: ' ' } } }],
  ['tool error empty scalar', { doneToolInfo: { error: '' } }],
  ['tool info string', { doneToolInfo: 'unparsed tool result' }],
  ['tool info array', { doneToolInfo: [{ error: 'unparsed tool failure' }] }],
  ['tool output object', { doneToolInfo: { output: { error: 'unparsed tool failure' } } }],
  ['tool parameters array', { doneToolInfo: { parameters: ['unknown target'] } }],
  ['earlier malformed error followed by clean DONE', { activeToolInfo: { error: { code: 'UNKNOWN' } } }],
  ['denial non-string action', { terminalFields: { denied_actions: [{ action: 17 }] } }],
  ['denial object container', { terminalFields: { denied_actions: { action: 'write_to_file' } } }],
  ['denial empty scalar', { terminalFields: { denied_actions: '' } }],
  ['denial null entry', { terminalFields: { denied_actions: [null] } }],
  ['denial missing action', { terminalFields: { denied_actions: [{}] } }],
];

for (const [name, evidence] of ambiguous) {
  test(`unreadable Native evidence blocks continuation: ${name}`, async () => {
    const f = await run('confirmed', evidence);
    assert.equal(f.calls, 1);
    assert.equal(f.writes.length, 1);
    assert.equal(f.effects, 'A\n');
    assert.ok(f.messages.some((message) => message.type === 'error'));
    if (Object.hasOwn(evidence, 'doneToolInfo') || Object.hasOwn(evidence, 'activeToolInfo')) {
      assert.ok(f.messages.some((message) => message.type === 'tool_result' && message.toolResultStatus === 'error'));
      assert.equal(
        f.messages.some((message) => message.type === 'tool_result' && message.toolResultStatus === 'ok'),
        false,
      );
    }
    assert.deepEqual(
      f.events.filter((event) => event.type === 'request_generation_terminal').map((event) => event.outcome),
      ['error'],
    );
  });
}

test('a sparse DONE cannot erase a previously observed tool error from streamed results', async () => {
  const f = await run('confirmed', { activeToolInfo: { error: { message: 'known unresolved tool failure' } } });
  assert.equal(f.calls, 1);
  const results = f.messages.filter((message) => message.type === 'tool_result');
  assert.equal(results.length, 1);
  assert.equal(results[0].toolResultStatus, 'error');
  assert.match(results[0].content, /known unresolved tool failure/);
});

for (const [name, evidence] of [
  ['known tool failure', { doneToolInfo: { error: { message: 'tool effect outcome unavailable' } } }],
  ['known denial', { terminalFields: { denied_actions: [{ action: 'write_to_file' }] } }],
]) {
  test(`recognized negative Native evidence still blocks continuation: ${name}`, async () => {
    const f = await run('confirmed', evidence);
    assert.equal(f.calls, 1);
    assert.equal(f.effects, 'A\n');
  });
}

for (const [name, evidence] of [
  ['absent optional tool fields and empty denial list', { doneToolInfo: {}, terminalFields: { denied_actions: [] } }],
  [
    'null optional tool fields and denial list',
    { doneToolInfo: { error: null, output: null, parameters: null }, terminalFields: { denied_actions: null } },
  ],
]) {
  test(`valid empty Native evidence preserves exact continuation: ${name}`, async () => {
    const f = await run('confirmed', evidence);
    assert.equal(f.calls, 2);
    assert.equal(f.effects, 'A\nB\n');
    assert.equal(
      f.messages.some((message) => message.type === 'error'),
      false,
    );
  });
}
