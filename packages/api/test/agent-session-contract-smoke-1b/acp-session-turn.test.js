// ACP capabilities, session opening and turn start reflect the underlying service.
//
// The adapter is a thin projection over the existing ACP `AgentService`: it
// declares what ACP cannot do, never claims continuity, and rebuilds the Host
// options for each turn from `TurnInput` instead of trusting whatever was on
// `hostOptions`.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AcpSessionProvider } from '../../dist/domains/cats/services/agents/session-contract/acp-session-provider.js';
import { AsyncInbox, agentMessage, collect, createFakeAgentService, turnInput, waitFor } from './fakes.js';

const CAT_ID = 'cat-1';
const HOST_SESSION_ID = 'host-session-1';

function signal() {
  return new AbortController().signal;
}

function makeProvider(config = {}) {
  const { service, calls } = createFakeAgentService(config);
  return { provider: new AcpSessionProvider({ catId: CAT_ID, service }), calls };
}

async function open(provider, overrides = {}) {
  return provider.openSession(
    {
      sessionId: HOST_SESSION_ID,
      instructions: 'be brief',
      cwd: '/tmp/work',
      ...overrides,
    },
    signal(),
  );
}

test('[39] ACP declares exactly the supported session capabilities', () => {
  const { provider } = makeProvider();

  assert.deepEqual(provider.capabilities(HOST_SESSION_ID), {
    input: 'unsupported',
    inputReadReceipt: 'unsupported',
    inspectInput: 'unsupported',
    compact: 'unsupported',
    cancelTurn: 'supported',
    observesCompaction: false,
    continuityEvidence: 'none',
  });
});

test('[39] openSession always reports pending_first_input', async () => {
  const { provider } = makeProvider();

  assert.deepEqual(await open(provider), { ok: true, binding: { state: 'pending_first_input' } });
  assert.deepEqual(await open(provider, { resume: { nativeSessionId: 'native-9', onUnavailable: 'start_new' } }), {
    ok: true,
    binding: { state: 'pending_first_input' },
  });
});

test('[39] a deferred prompt is refused before the service is touched', async () => {
  const { provider, calls } = makeProvider();
  await open(provider);

  const result = await provider.startTurn(
    HOST_SESSION_ID,
    {
      invocation: { invocationId: 'inv-1', callbackEnv: {} },
      prompt: { kind: 'deferred', settle: async () => ({ prompt: 'never', promptGenerationId: 'gen-1' }) },
    },
    signal(),
  );

  assert.equal(result.ok, false);
  assert.equal(result.code, 'failed');
  assert.equal(result.reason, 'deferred_prompt_unsupported');
  assert.equal(calls.invoke.length, 0);
});

test('[39] a second concurrent turn on the same session is busy', async () => {
  const inbox = new AsyncInbox();
  const { provider, calls } = makeProvider({ invoke: () => inbox });
  await open(provider);

  const first = await provider.startTurn(HOST_SESSION_ID, turnInput({ text: 'one' }), signal());
  assert.equal(first.ok, true);
  const draining = collect(first.events);
  await waitFor(() => calls.invoke.length === 1, 'the first turn to reach the service');

  const second = await provider.startTurn(HOST_SESSION_ID, turnInput({ text: 'two' }), signal());
  assert.equal(second.ok, false);
  assert.equal(second.code, 'busy');
  assert.equal(calls.invoke.length, 1, 'a busy turn must not reach the service');

  inbox.push(agentMessage('done'));
  inbox.close();
  await draining;

  const third = await provider.startTurn(HOST_SESSION_ID, turnInput({ text: 'three' }), signal());
  assert.equal(third.ok, true, 'an ended turn frees the session');
  await collect(third.events);
});

test('[39] the service receives a rebuilt options object, not the raw hostOptions', async () => {
  const { provider, calls } = makeProvider();
  await open(provider, { resume: { nativeSessionId: 'resume-1', onUnavailable: 'start_new' } });
  const callerSignal = signal();

  const hostOptions = {
    invocationId: 'stale-invocation',
    callbackEnv: { STALE: '1' },
    sessionId: 'stale-session',
    workingDirectory: '/tmp/work',
    systemPrompt: 'be brief',
    requiredTools: ['github::create_issue'],
    toolExecutionPolicy: { mode: 'default' },
  };

  const result = await provider.startTurn(
    HOST_SESSION_ID,
    {
      invocation: { invocationId: 'inv-9', callbackEnv: { CAT_CAFE_CALLBACK_TOKEN: 'token-1' } },
      prompt: { kind: 'frozen', text: 'the prompt' },
      hostOptions,
    },
    callerSignal,
  );

  assert.equal(result.ok, true);
  const options = calls.invoke[0].options;

  assert.equal(calls.invoke[0].prompt, 'the prompt');
  assert.notEqual(options, hostOptions, 'the adapter must copy, not forward');
  assert.equal(hostOptions.invocationId, 'stale-invocation', 'hostOptions must not be mutated');
  assert.equal(hostOptions.sessionId, 'stale-session', 'hostOptions must not be mutated');

  assert.equal(options.invocationId, 'inv-9');
  assert.deepEqual(options.callbackEnv, { CAT_CAFE_CALLBACK_TOKEN: 'token-1' });
  assert.equal(options.sessionId, 'resume-1', 'without a native_bound event the resume id wins');
  assert.equal(options.workingDirectory, '/tmp/work');
  assert.equal(options.systemPrompt, 'be brief');
  assert.deepEqual(options.requiredTools, ['github::create_issue']);
  assert.deepEqual(options.toolExecutionPolicy, { mode: 'default' });
  assert.ok(options.signal, 'the adapter owns the abort signal');
  assert.equal(options.signal.aborted, false);
  assert.notEqual(options.signal, callerSignal, 'the adapter aborts its own controller, not the caller signal');

  await collect(result.events);
});

test('[39] without a native id or a resume target the sessionId field is absent', async () => {
  const { provider, calls } = makeProvider();
  await open(provider);

  const result = await provider.startTurn(
    HOST_SESSION_ID,
    {
      invocation: { invocationId: 'inv-1', callbackEnv: {} },
      prompt: { kind: 'frozen', text: 'hello' },
      hostOptions: { sessionId: 'host-side-value', workingDirectory: '/tmp/work' },
    },
    signal(),
  );

  assert.equal(calls.invoke[0].options.sessionId, undefined, 'a stale id must not leak into the service');
  assert.equal(calls.invoke[0].options.workingDirectory, '/tmp/work');
  await collect(result.events);
});

test('[39] a turn without hostOptions still starts', async () => {
  const { provider, calls } = makeProvider();
  await open(provider);

  const result = await provider.startTurn(HOST_SESSION_ID, turnInput({ text: 'hello' }), signal());

  assert.equal(result.ok, true);
  assert.equal(calls.invoke[0].prompt, 'hello');
  assert.equal(calls.invoke[0].options.invocationId, 'inv-1');
  assert.deepEqual(calls.invoke[0].options.callbackEnv, { CAT_CAFE_CALLBACK_TOKEN: 'token-1' });
  await collect(result.events);
});

test('[46] startTurn reaches the service before any event is consumed, and not at all when it refuses', async () => {
  const inbox = new AsyncInbox();
  const { provider, calls } = makeProvider({ invoke: () => inbox });
  await open(provider);

  const started = await provider.startTurn(HOST_SESSION_ID, turnInput({ text: 'one' }), signal());

  assert.equal(started.ok, true);
  assert.equal(calls.invoke.length, 1, 'the service must be running before the first event is pulled');

  const refused = await provider.startTurn(
    'other-session',
    {
      invocation: { invocationId: 'inv-2', callbackEnv: {} },
      prompt: { kind: 'deferred', settle: async () => ({ prompt: 'never', promptGenerationId: 'gen-1' }) },
    },
    signal(),
  );

  assert.equal(refused.ok, false);
  assert.equal(calls.invoke.length, 1, 'a refused turn must not reach the service');

  inbox.push(agentMessage('done'));
  inbox.close();
  await collect(started.events);
});

test('[47] a repeated openSession keeps the learned native id, and a resume target overrides it', async () => {
  const { provider, calls } = makeProvider({
    invoke: () => [agentMessage('session_init', { sessionId: 'native-7' }), agentMessage('done')],
  });

  await open(provider);
  const first = await provider.startTurn(HOST_SESSION_ID, turnInput({ text: 'one' }), signal());
  await collect(first.events);

  await open(provider);
  const second = await provider.startTurn(HOST_SESSION_ID, turnInput({ text: 'two' }), signal());
  assert.equal(calls.invoke[1].options.sessionId, 'native-7', 'a bare reopen must not forget the native id');
  await collect(second.events);

  await open(provider, { resume: { nativeSessionId: 'resume-2', onUnavailable: 'start_new' } });
  const third = await provider.startTurn(HOST_SESSION_ID, turnInput({ text: 'three' }), signal());
  assert.equal(calls.invoke[2].options.sessionId, 'resume-2', 'the new resume target must win');
  await collect(third.events);
});
