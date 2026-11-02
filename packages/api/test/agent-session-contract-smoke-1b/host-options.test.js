// Host options reach Host-owned adapters when explicitly enabled.
//
// Every session implementation is Host code, so the bridge may hand the raw
// `AgentServiceOptions` to the provider. It stays opt-in so the default behaviour
// (nothing but the contract fields on the wire) is still the default.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AgentSessionBridgeService } from '../../dist/domains/cats/services/agents/session-contract/AgentSessionBridgeService.js';
import { collect, createFakeSessionProvider } from './fakes.js';

const HOST_SESSION_ID = 'host-session-1';

function bridgeFor(provider, extra = {}) {
  return new AgentSessionBridgeService({
    catId: 'cat-1',
    provider,
    resolveHostSession: () => ({ sessionId: HOST_SESSION_ID }),
    resolveMcpServers: () => [],
    ...extra,
  });
}

test('[34] without passHostOptions the turn carries no hostOptions', async () => {
  const { provider, calls } = createFakeSessionProvider();
  const service = bridgeFor(provider);
  const options = { invocationId: 'inv-1', systemPrompt: 'be brief', workingDirectory: '/tmp/work' };

  await collect(service.invoke('hello', options));

  assert.equal(calls.startTurn.length, 1);
  assert.equal(calls.startTurn[0].input.hostOptions, undefined);
});

test('[34] passHostOptions: false is the same as leaving it out', async () => {
  const { provider, calls } = createFakeSessionProvider();
  const service = bridgeFor(provider, { passHostOptions: false });
  const options = { invocationId: 'inv-1', systemPrompt: 'be brief' };

  await collect(service.invoke('hello', options));

  assert.equal(calls.startTurn[0].input.hostOptions, undefined);
});

test('[34] passHostOptions: true hands the caller the same options object', async () => {
  const { provider, calls } = createFakeSessionProvider();
  const service = bridgeFor(provider, { passHostOptions: true });
  const options = {
    invocationId: 'inv-1',
    systemPrompt: 'be brief',
    workingDirectory: '/tmp/work',
    callbackEnv: { CAT_CAFE_CALLBACK_TOKEN: 'token-1' },
    requiredTools: ['github::create_issue'],
    toolExecutionPolicy: { mode: 'default' },
  };

  await collect(service.invoke('hello', options));

  assert.equal(calls.startTurn.length, 1);
  // The direct bridge is unchanged — it hands over the caller object
  // itself. Only `RegisteredSessionAgentService` copies it.
  assert.equal(calls.startTurn[0].input.hostOptions, options);
  assert.equal(calls.startTurn[0].input.invocation.invocationId, 'inv-1');
  assert.deepEqual(calls.startTurn[0].input.invocation.callbackEnv, { CAT_CAFE_CALLBACK_TOKEN: 'token-1' });
});

test('[34] hostOptions is per call, not remembered between turns', async () => {
  const { provider, calls } = createFakeSessionProvider();
  const service = bridgeFor(provider, { passHostOptions: true });

  const first = { invocationId: 'inv-1', systemPrompt: 'one' };
  const second = { invocationId: 'inv-2', systemPrompt: 'two' };

  await collect(service.invoke('hello', first));
  await collect(service.invoke('hello again', second));

  assert.equal(calls.startTurn[0].input.hostOptions, first);
  assert.equal(calls.startTurn[1].input.hostOptions, second);
});
