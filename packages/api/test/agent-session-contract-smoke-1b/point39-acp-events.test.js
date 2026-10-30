// AgentMessage → contract events, including message-local usage and diagnostics.
//
// The adapter keeps each diagnostic's type and payload. Usage belongs to its
// emitted message, while model changes remain session-scoped context.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AcpSessionProvider } from '../../dist/domains/cats/services/agents/session-contract/acp-session-provider.js';
import { projectSessionEvent } from '../../dist/domains/cats/services/agents/session-contract/event-projection.js';
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

test('[39] tool_result without a native status remains unknown', async () => {
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

test('[39] a stream that ends without done gets exactly one completed done', async () => {
  const { provider } = providerFor([agentMessage('text', { content: 'only text' })]);

  const events = await runTurn(provider);
  const done = events.filter((event) => event.type === 'done');

  assert.equal(done.length, 1);
  assert.equal(done[0].outcome, 'completed');
  assert.equal(events.at(-1).type, 'done');
});

test('model changes update session context while usage stays on its original message', async () => {
  const usage = { inputTokens: 5, outputTokens: 2, totalTokens: 7 };
  const { provider } = providerFor([
    agentMessage('text', { content: 'a' }, { model: 'model-a' }),
    agentMessage('text', { content: 'b' }, { model: 'model-b', usage }),
    agentMessage('text', { content: 'c' }, { model: 'model-b' }),
    agentMessage('done', {}, { model: 'model-b' }),
  ]);

  const events = await runTurn(provider);
  const contexts = events.filter((event) => event.type === 'context');

  assert.deepEqual(
    contexts.map((event) => event.model),
    ['model-a', 'model-b'],
  );
  assert.ok(contexts.every((event) => event.scope === 'session' && event.usage === undefined));
  const outputs = events.filter((event) => event.type === 'output');
  assert.deepEqual(
    outputs.map((event) => event.messageUsage),
    [undefined, usage, undefined],
  );
  assert.equal(events.at(-1).messageUsage, undefined, 'usage must not leak into the terminal');

  const context = { catId: CAT_ID, metadata: { provider: 'fixture', model: 'initial' } };
  const projected = events.flatMap((event) => projectSessionEvent(event, context));
  assert.deepEqual(
    projected.map((message) => message.metadata.usage),
    [undefined, usage, undefined, undefined],
  );
  assert.deepEqual(
    projected.map((message) => message.metadata.model),
    ['model-a', 'model-b', 'model-b', 'model-b'],
  );
});

test('system and provider diagnostics retain their exact types and payloads', async () => {
  const diagnosticTypes = ['system_info', 'provider_signal', 'liveness_signal', 'agent_loop'];
  const payloads = diagnosticTypes.map((type) => JSON.stringify({ type, detail: 'fixture telemetry' }));
  const { provider } = providerFor([
    ...diagnosticTypes.map((type, index) => agentMessage(type, { content: payloads[index] })),
    agentMessage('status', { content: 'working' }),
    agentMessage('text', { content: 'reply' }),
    agentMessage('done'),
  ]);

  const events = await runTurn(provider);
  const diagnostics = events.filter((event) => diagnosticTypes.includes(event.type));
  assert.deepEqual(
    diagnostics.map((event) => event.type),
    diagnosticTypes,
  );
  assert.deepEqual(
    diagnostics.map((event) => event.content),
    payloads,
  );
  assert.ok(diagnostics.every((event) => event.scope === 'turn'));
  assert.deepEqual(
    events.filter((event) => event.type === 'status').map((event) => event.detail),
    ['working'],
  );
  assert.equal(events.filter((event) => event.type === 'output').length, 1);

  const context = { catId: CAT_ID, metadata: { provider: 'fixture', model: 'fixture' } };
  const projected = diagnostics.flatMap((event) => projectSessionEvent(event, context));
  assert.deepEqual(
    projected.map((message) => message.type),
    diagnosticTypes,
  );
  assert.deepEqual(
    projected.map((message) => message.content),
    payloads,
  );
});
