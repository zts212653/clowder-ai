// Entry selection respects per-session continuity capabilities.
//
// Preflight capability is a per-session fact, never a construction-time one:
//   * both entry points always exist;
//   * `invoke` always sends a frozen prompt, whatever the session's capability;
//   * `invokeWithContinuityPreflight` on a `'none'` session refuses before any
//     turn or settle happens;
//   * with no `options` there is no host session at all, so the bridge reports
//     `host_session_unavailable` without touching the provider.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AgentSessionBridgeService } from '../../dist/domains/cats/services/agents/session-contract/AgentSessionBridgeService.js';
import { collect, createFakeProvider } from './fake-provider.js';

const HOST_SESSION_ID = 'host-session-1';

/** Records any `resolveHostSession(undefined)` the bridge must never make. */
function bridgeFor(provider, overrides = {}) {
  const undefinedResolutions = [];
  const service = new AgentSessionBridgeService({
    catId: 'cat-1',
    provider,
    resolveHostSession: (options) => {
      if (options === undefined) {
        undefinedResolutions.push(true);
        return { sessionId: 'never-used' };
      }
      return { sessionId: HOST_SESSION_ID };
    },
    resolveMcpServers: () => [{ name: 'mcp-1' }],
    ...overrides,
  });
  return { service, undefinedResolutions };
}

function assertNoProviderCalls(calls) {
  for (const [method, recorded] of Object.entries(calls)) {
    assert.equal(recorded.length, 0, `provider.${method} must not be called`);
  }
}

function outputThenDone(ctx) {
  return [
    { scope: 'turn', sessionId: ctx.sessionId, turn: ctx.turn, seq: 1, type: 'output', text: 'ok', textMode: 'append' },
    { scope: 'turn', sessionId: ctx.sessionId, turn: ctx.turn, seq: 2, type: 'done', outcome: 'completed' },
  ];
}

test('[1] both entry points exist and construction touches neither the provider nor a host session', () => {
  const { provider, calls } = createFakeProvider({ continuityEvidence: 'none' });
  const { service, undefinedResolutions } = bridgeFor(provider);

  assert.equal(typeof service.invoke, 'function');
  assert.equal(typeof service.invokeWithContinuityPreflight, 'function');
  assert.deepEqual(undefinedResolutions, []);
  assertNoProviderCalls(calls);
});

test('[1] missing options produces host_session_unavailable without calling the provider', async () => {
  const { provider, calls } = createFakeProvider({ continuityEvidence: 'none' });
  const { service, undefinedResolutions } = bridgeFor(provider);

  const messages = await collect(service.invoke('p'));

  assert.deepEqual(
    messages.map((m) => m.type),
    ['error', 'done'],
  );
  assert.equal(messages[0].errorCode, 'host_session_unavailable');
  assert.equal(messages[1].errorCode, 'host_session_unavailable', 'the done repeats the error code');
  assert.deepEqual(undefinedResolutions, [], 'resolveHostSession must never receive undefined');
  assertNoProviderCalls(calls);
});

test('[1] missing options on the preflight entry also refuses without calling the provider', async () => {
  const { provider, calls } = createFakeProvider({ continuityEvidence: 'pre_send' });
  const { service, undefinedResolutions } = bridgeFor(provider);
  const settleCalls = [];

  const messages = await collect(
    service.invokeWithContinuityPreflight({
      requestedRuntimeSessionId: 'native-old',
      settle: async (facts) => {
        settleCalls.push(facts);
        return { prompt: 'MUST-NOT-BE-SENT', promptGenerationId: 'gen-1' };
      },
    }),
  );

  assert.deepEqual(
    messages.map((m) => m.type),
    ['error', 'done'],
  );
  assert.equal(messages[0].errorCode, 'host_session_unavailable');
  assert.equal(messages[1].errorCode, 'host_session_unavailable', 'the done repeats the error code');
  assert.deepEqual(undefinedResolutions, []);
  assertNoProviderCalls(calls);
  assert.equal(settleCalls.length, 0);
});

test('[1] invoke sends a frozen prompt for a none session', async () => {
  const { provider, calls, sent } = createFakeProvider({ continuityEvidence: 'none', events: outputThenDone });
  const { service } = bridgeFor(provider);

  const messages = await collect(service.invoke('PROMPT-BYTES-1', { invocationId: 'inv-1' }));

  assert.equal(calls.openSession.length, 1);
  assert.deepEqual(calls.startTurn[0].input.prompt, { kind: 'frozen', text: 'PROMPT-BYTES-1' });
  assert.deepEqual(sent, ['PROMPT-BYTES-1']);
  assert.deepEqual(
    messages.map((m) => m.type),
    ['text', 'done'],
  );
});

test('[1] invokeWithContinuityPreflight on a none session refuses before the turn and before settle', async () => {
  const { provider, calls } = createFakeProvider({ continuityEvidence: 'none' });
  const { service } = bridgeFor(provider);
  const settleCalls = [];

  const messages = await collect(
    service.invokeWithContinuityPreflight(
      {
        requestedRuntimeSessionId: 'native-old',
        settle: async (facts) => {
          settleCalls.push(facts);
          return { prompt: 'MUST-NOT-BE-SENT', promptGenerationId: 'gen-1' };
        },
      },
      { invocationId: 'inv-1' },
    ),
  );

  assert.deepEqual(
    messages.map((m) => m.type),
    ['error', 'done'],
  );
  assert.equal(messages[0].errorCode, 'continuity_preflight_unsupported');
  assert.equal(messages[1].errorCode, 'continuity_preflight_unsupported', 'the done repeats the error code');
  assert.equal(calls.openSession.length, 1, 'the session must be opened to learn its capability');
  assert.ok(calls.capabilities.length >= 1, 'capability must be read for the real session');
  assert.equal(calls.startTurn.length, 0);
  assert.equal(settleCalls.length, 0);
});

test('[1] invoke sends a frozen prompt even for a pre_send session', async () => {
  const { provider, calls, sent } = createFakeProvider({ continuityEvidence: 'pre_send', events: outputThenDone });
  const { service } = bridgeFor(provider);

  const messages = await collect(service.invoke('FROZEN-EVEN-HERE', { invocationId: 'inv-1' }));

  assert.deepEqual(calls.startTurn[0].input.prompt, { kind: 'frozen', text: 'FROZEN-EVEN-HERE' });
  assert.deepEqual(sent, ['FROZEN-EVEN-HERE']);
  assert.deepEqual(
    messages.map((m) => m.type),
    ['text', 'done'],
  );
});

test('[1] a turn carries the host invocation id, the callback env and the MCP list', async () => {
  const callbackEnv = { CAT_CAFE_INVOCATION_ID: 'inv-7', CAT_CAFE_CALLBACK_TOKEN: 'token-7' };
  const { provider, calls } = createFakeProvider({ continuityEvidence: 'none' });
  const { service } = bridgeFor(provider);

  await collect(service.invoke('p', { invocationId: 'inv-7', callbackEnv }));

  const [turn] = calls.startTurn;
  assert.equal(turn.sessionId, HOST_SESSION_ID);
  assert.equal(turn.input.invocation.invocationId, 'inv-7');
  assert.deepEqual(turn.input.invocation.callbackEnv, callbackEnv);
  assert.deepEqual(turn.input.invocation.mcpServers, [{ name: 'mcp-1' }]);
  assert.equal(calls.openSession.length, 1);
  assert.equal(calls.openSession[0].sessionId, HOST_SESSION_ID);
});

test('[1] a missing callbackEnv reaches the provider as an empty object', async () => {
  const { provider, calls } = createFakeProvider({ continuityEvidence: 'none' });
  const { service } = bridgeFor(provider);

  await collect(service.invoke('p', { invocationId: 'inv-1' }));

  assert.deepEqual(calls.startTurn[0].input.invocation.callbackEnv, {});
});

test('[1] a second turn on the same host session reuses the open session', async () => {
  const { provider, calls } = createFakeProvider({ continuityEvidence: 'none' });
  const { service } = bridgeFor(provider);

  await collect(service.invoke('first', { invocationId: 'inv-1' }));
  await collect(service.invoke('second', { invocationId: 'inv-2' }));

  assert.equal(calls.openSession.length, 1);
  assert.equal(calls.startTurn.length, 2);
  assert.equal(calls.startTurn[1].input.prompt.text, 'second');
});
