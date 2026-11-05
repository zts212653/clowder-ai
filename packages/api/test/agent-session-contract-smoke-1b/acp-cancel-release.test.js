// ACP cancellation interrupts the turn and release uses known native sessions.
//
// Cancellation must reach the running turn through the adapter's own signal, and
// release must not claim more than it did: it only calls `releaseSession` when it
// knows a native id and the underlying service offers one.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AcpSessionProvider } from '../../dist/domains/cats/services/agents/session-contract/acp-session-provider.js';
import { AsyncInbox, agentMessage, collect, createFakeAgentService, turnInput, waitFor } from './fakes.js';

const CAT_ID = 'cat-1';
const HOST_SESSION_ID = 'host-session-1';
const EXPECTED = { invocationId: 'inv-1' };

function signal() {
  return new AbortController().signal;
}

function makeProvider(config = {}) {
  const { service, calls } = createFakeAgentService(config);
  return { provider: new AcpSessionProvider({ catId: CAT_ID, service }), calls };
}

async function open(provider) {
  const result = await provider.openSession({ sessionId: HOST_SESSION_ID, instructions: '', cwd: '/tmp' }, signal());
  assert.equal(result.ok, true);
}

test('[39] cancelling a running turn aborts the adapter signal and reports cancelled', async () => {
  const inbox = new AsyncInbox();
  const { provider, calls } = makeProvider({ invoke: () => inbox });
  await open(provider);

  const started = await provider.startTurn(HOST_SESSION_ID, turnInput({ text: 'one' }), signal());
  assert.equal(started.ok, true);
  const draining = collect(started.events);
  await waitFor(() => calls.invoke.length === 1, 'the turn to reach the service');

  const cancelled = await provider.cancelTurn(HOST_SESSION_ID, EXPECTED, 'user_requested');

  assert.deepEqual(cancelled, { ok: true });
  assert.equal(calls.invoke[0].options.signal.aborted, true, 'the service signal must be aborted');

  inbox.push(agentMessage('done'));
  inbox.close();
  const events = await draining;

  const done = events.filter((event) => event.type === 'done');
  assert.equal(done.length, 1);
  assert.equal(done[0].outcome, 'cancelled');
});

test('[39] cancel without a running turn reports turn_ended', async () => {
  const { provider, calls } = makeProvider();
  await open(provider);

  assert.deepEqual(await provider.cancelTurn(HOST_SESSION_ID, EXPECTED, 'user_requested'), {
    ok: false,
    code: 'turn_ended',
  });

  const unknown = await provider.cancelTurn('unknown-session', EXPECTED, 'user_requested');
  assert.equal(unknown.ok, false);
  assert.equal(unknown.code, 'turn_ended');
  assert.equal(calls.invoke.length, 0);
});

test('[39] cancel after the turn ended reports turn_ended', async () => {
  const { provider } = makeProvider({
    invoke: () => [agentMessage('text', { content: 'x' }), agentMessage('done')],
  });
  await open(provider);

  const started = await provider.startTurn(HOST_SESSION_ID, turnInput({ text: 'one' }), signal());
  await collect(started.events);

  assert.deepEqual(await provider.cancelTurn(HOST_SESSION_ID, EXPECTED, 'user_requested'), {
    ok: false,
    code: 'turn_ended',
  });
});

test('[39] release hands the native id to releaseSession', async () => {
  const { provider, calls } = makeProvider({
    invoke: () => [agentMessage('session_init', { sessionId: 'native-7' }), agentMessage('done')],
  });
  await open(provider);

  const started = await provider.startTurn(HOST_SESSION_ID, turnInput({ text: 'one' }), signal());
  await collect(started.events);

  assert.deepEqual(await provider.release(HOST_SESSION_ID, 'shutdown'), { ok: true });
  assert.deepEqual(calls.releaseSession, ['native-7']);
});

test('[39] release does not call releaseSession when it has no native id', async () => {
  const { provider, calls } = makeProvider();
  await open(provider);

  assert.deepEqual(await provider.release(HOST_SESSION_ID, 'shutdown'), { ok: true });
  assert.deepEqual(calls.releaseSession, []);
});

test('[39] release works when the wrapped service has no releaseSession', async () => {
  const { provider, calls } = makeProvider({
    withReleaseSession: false,
    invoke: () => [agentMessage('session_init', { sessionId: 'native-7' }), agentMessage('done')],
  });
  await open(provider);

  const started = await provider.startTurn(HOST_SESSION_ID, turnInput({ text: 'one' }), signal());
  await collect(started.events);

  assert.deepEqual(await provider.release(HOST_SESSION_ID, 'shutdown'), { ok: true });
  assert.deepEqual(calls.releaseSession, []);
});

test('[39] a throwing releaseSession becomes a failed release', async () => {
  const { provider } = makeProvider({
    releaseSessionThrows: true,
    invoke: () => [agentMessage('session_init', { sessionId: 'native-7' }), agentMessage('done')],
  });
  await open(provider);

  const started = await provider.startTurn(HOST_SESSION_ID, turnInput({ text: 'one' }), signal());
  await collect(started.events);

  const result = await provider.release(HOST_SESSION_ID, 'shutdown');

  assert.equal(result.ok, false);
  assert.equal(result.code, 'failed');
  assert.equal(typeof result.reason, 'string');
  assert.ok(result.reason.length > 0);
});
