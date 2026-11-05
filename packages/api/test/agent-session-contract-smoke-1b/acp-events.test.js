// ACP AgentMessages project into session contract events.
//
// The adapter is the only place that knows how ACP-shaped AgentMessages look, so
// this table verifies the translation surface, including system and telemetry
// events whose types must survive until Host invocation policy handles them.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AcpSessionProvider } from '../../dist/domains/cats/services/agents/session-contract/acp-session-provider.js';
import { agentMessage, collect, createFakeAgentService, turnInput } from './fakes.js';

const CAT_ID = 'cat-1';
const HOST_SESSION_ID = 'host-session-1';

function signal() {
  return new AbortController().signal;
}

function providerFor(script) {
  const { service, calls } = createFakeAgentService({
    invoke: typeof script === 'function' ? script : () => script,
  });
  const provider = new AcpSessionProvider({ catId: CAT_ID, service });
  return { provider, calls };
}

async function runTurn(provider, { text = 'hello', hostOptions } = {}) {
  const opened = await provider.openSession({ sessionId: HOST_SESSION_ID, instructions: '', cwd: '/tmp' }, signal());
  assert.equal(opened.ok, true);
  const started = await provider.startTurn(HOST_SESSION_ID, turnInput({ text, hostOptions }), signal());
  assert.equal(started.ok, true);
  return collect(started.events);
}

test('[39] session_init becomes a session-scoped native_bound', async () => {
  const { provider } = providerFor([agentMessage('session_init', { sessionId: 'native-7' }), agentMessage('done')]);

  const events = await runTurn(provider);
  const bound = events.filter((event) => event.type === 'native_bound');

  assert.equal(bound.length, 1);
  assert.equal(bound[0].scope, 'session');
  assert.equal(bound[0].nativeSessionId, 'native-7');
  assert.equal(bound[0].sessionId, HOST_SESSION_ID);
});

test('[39] the native id from native_bound is used for later turns', async () => {
  const { provider, calls } = providerFor([
    agentMessage('session_init', { sessionId: 'native-7' }),
    agentMessage('done'),
  ]);

  await runTurn(provider);
  await runTurn(provider);

  assert.equal(calls.invoke[0].options.sessionId, undefined);
  assert.equal(calls.invoke[1].options.sessionId, 'native-7');
});

test('[39] text becomes output and keeps or defaults the textMode', async () => {
  const { provider } = providerFor([
    agentMessage('text', { content: 'snapshot', textMode: 'replace' }),
    agentMessage('text', { content: 'delta' }),
    agentMessage('done'),
  ]);

  const events = await runTurn(provider);
  const outputs = events.filter((event) => event.type === 'output');

  assert.equal(outputs.length, 2);
  assert.equal(outputs[0].scope, 'turn');
  assert.equal(outputs[0].text, 'snapshot');
  assert.equal(outputs[0].textMode, 'replace');
  assert.equal(outputs[1].text, 'delta');
  assert.equal(outputs[1].textMode, 'append');
});

test('[39] tool_use becomes tool_call keyed by the native tool id', async () => {
  const { provider } = providerFor([
    agentMessage('tool_use', { toolName: 'read_file', toolInput: { path: 'a.txt' }, toolUseId: 'call-1' }),
    agentMessage('tool_use', { toolName: 'ping' }),
    agentMessage('done'),
  ]);

  const events = await runTurn(provider);
  const calls = events.filter((event) => event.type === 'tool_call');

  assert.equal(calls.length, 2);
  assert.equal(calls[0].callId, 'call-1');
  assert.equal(calls[0].name, 'read_file');
  assert.deepEqual(calls[0].input, { path: 'a.txt' });
  assert.equal(calls[1].callId, undefined);
  assert.equal(calls[1].name, 'ping');
});

test('[39] tool_result without native status remains unknown', async () => {
  const { provider } = providerFor([
    agentMessage('tool_result', { toolName: 'read_file', content: 'file body', toolUseId: 'call-1' }),
    agentMessage('done'),
  ]);

  const events = await runTurn(provider);
  const [result] = events.filter((event) => event.type === 'tool_result');

  assert.equal(result.callId, 'call-1');
  assert.equal(result.name, 'read_file');
  assert.equal(result.status, 'unknown');
  assert.equal(result.output, 'file body');
});

test('[39] error becomes a terminal error event with a default code', async () => {
  const { provider } = providerFor([
    agentMessage('error', { error: 'upstream exploded', errorCode: 'upstream_500' }),
    agentMessage('error', { error: 'no code here' }),
    agentMessage('done'),
  ]);

  const events = await runTurn(provider);
  const errors = events.filter((event) => event.type === 'error');

  assert.equal(errors.length, 2);
  assert.equal(errors[0].code, 'upstream_500');
  assert.equal(errors[0].message, 'upstream exploded');
  assert.equal(errors[0].disposition, 'terminal');
  assert.equal(errors[1].code, 'provider_error');
  assert.equal(errors[1].message, 'no code here');
});

test('[39] done keeps its errorCode and maps to failed', async () => {
  const { provider } = providerFor([
    agentMessage('text', { content: 'x' }),
    agentMessage('done', { errorCode: 'boom' }),
  ]);

  const events = await runTurn(provider);
  const done = events.filter((event) => event.type === 'done');

  assert.equal(done.length, 1);
  assert.equal(done[0].outcome, 'failed');
  assert.equal(done[0].errorCode, 'boom');
});

test('[39] a plain done maps to completed without an errorCode', async () => {
  const { provider } = providerFor([agentMessage('text', { content: 'x' }), agentMessage('done')]);

  const events = await runTurn(provider);
  const done = events.filter((event) => event.type === 'done');

  assert.equal(done.length, 1);
  assert.equal(done[0].outcome, 'completed');
  assert.equal(done[0].errorCode, undefined);
});

test('[39] a stream that ends without done fails instead of reporting success', async () => {
  const { provider } = providerFor([agentMessage('text', { content: 'only text' })]);

  const events = await runTurn(provider);
  const done = events.filter((event) => event.type === 'done');

  assert.equal(done.length, 1);
  assert.equal(done[0].outcome, 'failed');
  assert.equal(done[0].errorCode, 'provider_stream_ended_without_done');
  assert.equal(events.at(-1).type, 'done');
});

test('model changes update session context; usage belongs to each message', async () => {
  const usage = { inputTokens: 5, outputTokens: 2, totalTokens: 7 };
  const { provider } = providerFor([
    agentMessage('text', { content: 'a' }, { model: 'model-a' }),
    agentMessage('text', { content: 'b' }, { model: 'model-b', usage }),
    agentMessage('done'),
  ]);

  const events = await runTurn(provider);
  const contexts = events.filter((event) => event.type === 'context');

  assert.ok(contexts.length >= 1, 'a changed model/usage must be observable');
  const changed = contexts.find((event) => event.model === 'model-b');
  assert.ok(changed, 'the new model must be reported');
  assert.equal(changed.scope, 'session');
  assert.equal(changed.usage, undefined);
  assert.deepEqual(events.find((event) => event.text === 'b').messageUsage, usage);
  assert.equal(events.at(-1).messageUsage, undefined);
});

test('system and telemetry events retain their types and content', async () => {
  const originals = ['system_info', 'provider_signal', 'liveness_signal', 'agent_loop'].map((type) =>
    agentMessage(type, { content: `${type} body` }),
  );
  const { provider } = providerFor([...originals, agentMessage('text', { content: 'reply' }), agentMessage('done')]);

  const events = await runTurn(provider);
  for (const original of originals) {
    const event = events.find((event) => event.type === original.type);
    assert.ok(event);
    assert.equal(event.content, original.content);
  }
  assert.equal(
    events.some((event) => event.type === 'status'),
    false,
  );
  assert.equal(events.filter((event) => event.type === 'output').length, 1);
});
