// Per-cat services resolve implementations lazily and report unavailable plugins.
//
// A bound cat must be able to exist before its plugin is enabled. The service
// therefore resolves the implementation on every call, keeps one bridge per
// provider object, and turns every "not available" state into an explicit error
// instead of a crash.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SessionImplementationRegistry } from '../../dist/domains/cats/services/agents/session-contract/implementation-registry.js';
import { RegisteredSessionAgentService } from '../../dist/domains/cats/services/agents/session-contract/registered-session-agent-service.js';
import { collect, createFakeSessionProvider } from './fakes.js';

const REF = { pluginId: 'acme', contributionId: 'intranet-agent' };
const CAT_ID = 'cat-1';
const HOST_SESSION_ID = 'host-session-1';

function codes(messages) {
  return messages.map((message) => `${message.type}:${message.errorCode ?? ''}`);
}

function makeService({ registry = new SessionImplementationRegistry(), log } = {}) {
  return new RegisteredSessionAgentService({
    catId: CAT_ID,
    ref: REF,
    registry,
    metadata: { provider: 'acme-acp', model: 'agent-1' },
    ...(log ? { log } : {}),
  });
}

function registerProvider(registry, config = {}) {
  const fake = createFakeSessionProvider(config);
  const unregister = registry.register(REF, () => fake.provider);
  return { ...fake, unregister };
}

test('[38] an unregistered implementation yields session_implementation_unavailable and calls no provider', async () => {
  const registry = new SessionImplementationRegistry();
  const service = makeService({ registry });

  const messages = await collect(service.invoke('hello', { invocationId: 'inv-1', hostSessionId: HOST_SESSION_ID }));

  assert.deepEqual(codes(messages), [
    'error:session_implementation_unavailable',
    'done:session_implementation_unavailable',
  ]);
  assert.equal(messages.at(-1).type, 'done');
});

test('[38] a missing hostSessionId yields host_session_unavailable before any provider call', async () => {
  const registry = new SessionImplementationRegistry();
  const { calls } = registerProvider(registry);
  const service = makeService({ registry });

  const messages = await collect(service.invoke('hello', { invocationId: 'inv-1' }));

  assert.deepEqual(codes(messages), ['error:host_session_unavailable', 'done:host_session_unavailable']);
  assert.equal(calls.openSession.length, 0);
  assert.equal(calls.startTurn.length, 0);
});

test('[38] an empty hostSessionId is treated as missing', async () => {
  const registry = new SessionImplementationRegistry();
  const { calls } = registerProvider(registry);
  const service = makeService({ registry });

  const messages = await collect(service.invoke('hello', { invocationId: 'inv-1', hostSessionId: '' }));

  assert.deepEqual(codes(messages), ['error:host_session_unavailable', 'done:host_session_unavailable']);
  assert.equal(calls.openSession.length, 0);
});

test('[38] hostSessionId is the session id and options.sessionId is the resume target', async () => {
  const registry = new SessionImplementationRegistry();
  const { calls } = registerProvider(registry);
  const service = makeService({ registry });

  await collect(
    service.invoke('hello', {
      invocationId: 'inv-1',
      hostSessionId: HOST_SESSION_ID,
      sessionId: 'native-resume-1',
      systemPrompt: 'be brief',
      workingDirectory: '/tmp/work',
    }),
  );

  assert.equal(calls.openSession.length, 1);
  assert.equal(calls.openSession[0].sessionId, HOST_SESSION_ID);
  assert.deepEqual(calls.openSession[0].resume, {
    nativeSessionId: 'native-resume-1',
    onUnavailable: 'start_new',
  });
  assert.equal(calls.openSession[0].instructions, 'be brief');
  assert.equal(calls.openSession[0].cwd, '/tmp/work');
  assert.equal(calls.startTurn[0].sessionId, HOST_SESSION_ID);
});

test('[38] a replaced provider releases the old session exactly once', async () => {
  const registry = new SessionImplementationRegistry();
  const first = registerProvider(registry);
  const service = makeService({ registry });

  await collect(service.invoke('hello', { invocationId: 'inv-1', hostSessionId: HOST_SESSION_ID }));
  assert.equal(first.calls.openSession.length, 1);

  first.unregister();
  const second = registerProvider(registry);

  await collect(service.invoke('hello again', { invocationId: 'inv-2', hostSessionId: HOST_SESSION_ID }));

  assert.deepEqual(first.calls.release, [{ sessionId: HOST_SESSION_ID, reason: 'implementation_replaced' }]);
  assert.equal(second.calls.openSession.length, 1);
  assert.equal(second.calls.openSession[0].sessionId, HOST_SESSION_ID);
});

test('[38] unregistering releases the cached session and then reports the implementation as unavailable', async () => {
  const registry = new SessionImplementationRegistry();
  const fake = registerProvider(registry);
  const service = makeService({ registry });

  await collect(service.invoke('hello', { invocationId: 'inv-1', hostSessionId: HOST_SESSION_ID }));

  fake.unregister();

  const messages = await collect(service.invoke('hello', { invocationId: 'inv-2', hostSessionId: HOST_SESSION_ID }));

  assert.deepEqual(codes(messages), [
    'error:session_implementation_unavailable',
    'done:session_implementation_unavailable',
  ]);
  assert.deepEqual(fake.calls.release, [{ sessionId: HOST_SESSION_ID, reason: 'implementation_unavailable' }]);
});

test('[38] releaseAll reaches the cached bridge, and is a no-op without one', async () => {
  const registry = new SessionImplementationRegistry();
  const fake = registerProvider(registry);
  const service = makeService({ registry });

  await assert.doesNotReject(() => service.releaseAll('before-any-call'));
  assert.equal(fake.calls.release.length, 0);

  await collect(service.invoke('hello', { invocationId: 'inv-1', hostSessionId: HOST_SESSION_ID }));
  await service.releaseAll('shutdown');

  assert.deepEqual(fake.calls.release, [{ sessionId: HOST_SESSION_ID, reason: 'shutdown' }]);
});

test('[38] the service exposes invokeWithContinuityPreflight and a none-capability session refuses it', async () => {
  const registry = new SessionImplementationRegistry();
  const { calls } = registerProvider(registry);
  const service = makeService({ registry });

  assert.equal(typeof service.invokeWithContinuityPreflight, 'function');

  const messages = await collect(
    service.invokeWithContinuityPreflight(
      { settle: async () => ({ prompt: 'never sent', promptGenerationId: 'gen-1' }) },
      { invocationId: 'inv-1', hostSessionId: HOST_SESSION_ID },
    ),
  );

  assert.ok(messages.length >= 2);
  assert.equal(messages[0].type, 'error');
  assert.equal(messages[0].errorCode, 'continuity_preflight_unsupported');
  assert.equal(messages.at(-1).type, 'done');
  assert.equal(calls.startTurn.length, 0);
});

test('[34] hostOptions is a per-turn copy whose signal follows the caller', async () => {
  const registry = new SessionImplementationRegistry();
  const { calls } = registerProvider(registry);
  const service = makeService({ registry });
  const controller = new AbortController();

  const options = {
    invocationId: 'inv-1',
    hostSessionId: HOST_SESSION_ID,
    sessionId: 'native-resume-1',
    systemPrompt: 'be brief',
    workingDirectory: '/tmp/work',
    callbackEnv: { CAT_CAFE_CALLBACK_TOKEN: 'token-1' },
    requiredTools: ['github::create_issue'],
    signal: controller.signal,
  };
  const callerKeys = Object.keys(options).sort();

  await collect(service.invoke('hello', options));

  assert.equal(calls.startTurn.length, 1);
  const hostOptions = calls.startTurn[0].input.hostOptions;

  assert.ok(hostOptions, 'the provider must receive hostOptions');
  assert.notEqual(hostOptions, options, 'hostOptions must not be the caller object itself');

  for (const key of Object.keys(options)) {
    if (key === 'signal') continue;
    assert.equal(hostOptions[key], options[key], `hostOptions.${key} must be the caller's value`);
  }

  assert.ok(hostOptions.signal, 'hostOptions must carry a signal');
  assert.equal(hostOptions.signal.aborted, false);

  controller.abort();
  assert.equal(hostOptions.signal.aborted, true, 'aborting the caller must abort the turn signal');

  assert.deepEqual(Object.keys(options).sort(), callerKeys, 'the caller options must not be rewritten');
  assert.equal(options.hostSessionId, HOST_SESSION_ID);
  assert.equal(options.signal, controller.signal);
});
