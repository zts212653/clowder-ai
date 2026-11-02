// Pre-send settlement gates prompts and receives continuity evidence.
//
// These are the F296 preflight behaviours, expressed against the contract:
// no prompt byte may exist before `settle` resolves, the evidence the adapter
// observed is what `settle` receives, a failure before the verdict never
// settles, and compactions drained between turns arrive verbatim.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AgentSessionBridgeService } from '../../dist/domains/cats/services/agents/session-contract/AgentSessionBridgeService.js';
import { collect, createFakeProvider } from './fake-provider.js';

const HOST_SESSION_ID = 'host-session-1';

function bridgeFor(provider) {
  return new AgentSessionBridgeService({
    catId: 'cat-1',
    provider,
    resolveHostSession: () => ({ sessionId: HOST_SESSION_ID }),
    resolveMcpServers: () => [],
  });
}

function preflightWith(settle) {
  return { requestedRuntimeSessionId: 'native-old', settle };
}

function completedTurn(sessionId) {
  return [
    {
      scope: 'turn',
      sessionId,
      turn: { invocationId: 'inv-1', nativeTurnId: 'turn-1' },
      seq: 1,
      type: 'output',
      text: 'ok',
      textMode: 'append',
    },
    {
      scope: 'turn',
      sessionId,
      turn: { invocationId: 'inv-1', nativeTurnId: 'turn-1' },
      seq: 2,
      type: 'done',
      outcome: 'completed',
    },
  ];
}

test('[2] a pre_send provider receives a deferred prompt and nothing is sent before settle resolves', async () => {
  const settleCalls = [];
  /** Prompts already on the wire at the moment settle resolved. */
  let sentAtSettle = null;

  const { provider, calls, sent } = createFakeProvider({
    continuityEvidence: 'pre_send',
    evidence: { kind: 'started', runtimeSessionId: 'native-new' },
    events: completedTurn,
  });
  const service = bridgeFor(provider);

  const messages = await collect(
    service.invokeWithContinuityPreflight(
      preflightWith(async (facts) => {
        settleCalls.push(facts);
        sentAtSettle = sent.slice();
        return { prompt: 'PROMPT-AFTER-SETTLE', promptGenerationId: 'gen-1' };
      }),
      { invocationId: 'inv-1' },
    ),
  );

  assert.equal(calls.startTurn.length, 1);
  assert.equal(calls.startTurn[0].input.prompt.kind, 'deferred');
  assert.equal(typeof calls.startTurn[0].input.prompt.settle, 'function');
  assert.equal('text' in calls.startTurn[0].input.prompt, false);

  assert.equal(settleCalls.length, 1, 'host settle must be called exactly once');
  assert.deepEqual(sentAtSettle, [], 'no prompt bytes may be sent before settle resolves');
  assert.deepEqual(sent, ['PROMPT-AFTER-SETTLE']);
  assert.deepEqual(
    messages.map((m) => m.type),
    ['text', 'done'],
  );
});

test('[3] a replaced verdict is what settle receives, and only its prompt is sent', async () => {
  const replaced = {
    kind: 'replaced',
    requestedRuntimeSessionId: 'native-old',
    runtimeSessionId: 'native-new',
  };
  const settleCalls = [];

  const { provider, sent } = createFakeProvider({
    continuityEvidence: 'pre_send',
    evidence: replaced,
    events: completedTurn,
  });
  const service = bridgeFor(provider);

  await collect(
    service.invokeWithContinuityPreflight(
      preflightWith(async (facts) => {
        settleCalls.push(facts);
        return { prompt: `PROMPT-FOR-${facts.evidence.runtimeSessionId}`, promptGenerationId: 'gen-replaced' };
      }),
      { invocationId: 'inv-1' },
    ),
  );

  assert.equal(settleCalls.length, 1);
  assert.deepEqual(settleCalls[0].evidence, replaced);
  assert.deepEqual(sent, ['PROMPT-FOR-native-new']);
});

test('[4] a failure before the verdict never settles and ends the stream with error + done', async () => {
  const settleCalls = [];

  const { provider, calls, sent } = createFakeProvider({
    continuityEvidence: 'pre_send',
    skipSettle: true,
    events: (ctx) => [
      {
        scope: 'turn',
        sessionId: ctx.sessionId,
        turn: ctx.turn,
        seq: 1,
        type: 'error',
        code: 'transport_failed',
        message: 'wire closed before the verdict',
        disposition: 'terminal',
      },
      {
        scope: 'turn',
        sessionId: ctx.sessionId,
        turn: ctx.turn,
        seq: 2,
        type: 'done',
        outcome: 'failed',
        errorCode: 'transport_failed',
      },
    ],
  });
  const service = bridgeFor(provider);

  const messages = await collect(
    service.invokeWithContinuityPreflight(
      preflightWith(async (facts) => {
        settleCalls.push(facts);
        return { prompt: 'MUST-NOT-BE-SENT', promptGenerationId: 'gen-1' };
      }),
      { invocationId: 'inv-1' },
    ),
  );

  assert.equal(calls.startTurn.length, 1);
  assert.equal(settleCalls.length, 0, 'settle must not run without a verdict');
  assert.deepEqual(sent, [], 'no prompt bytes may be sent without a verdict');

  // The provider already emitted its done, so the bridge adds none.
  assert.deepEqual(
    messages.map((m) => m.type),
    ['error', 'done'],
  );
  assert.equal(messages.at(-1).errorCode, 'transport_failed');
  assert.equal(messages[0].errorCode, 'transport_failed');
  assert.equal(messages[0].error, 'wire closed before the verdict');
});

test('[5] compactions drained between turns reach settle verbatim, exactly once', async () => {
  const compactions = [
    { eventId: 'compaction-1', runtimeSessionId: 'native-old', evidenceRef: 'evidence-1' },
    { eventId: 'compaction-2', runtimeSessionId: 'native-old', evidenceRef: 'evidence-2' },
  ];
  const settleCalls = [];
  /** Identity of the array and of each element, captured inside settle. */
  let received = null;

  const { provider } = createFakeProvider({
    continuityEvidence: 'pre_send',
    evidence: { kind: 'resumed', requestedRuntimeSessionId: 'native-old', runtimeSessionId: 'native-old' },
    compactions,
    events: completedTurn,
  });
  const service = bridgeFor(provider);

  await collect(
    service.invokeWithContinuityPreflight(
      preflightWith(async (facts) => {
        settleCalls.push(facts);
        received = facts.compactions;
        return { prompt: 'PROMPT', promptGenerationId: 'gen-1' };
      }),
      { invocationId: 'inv-1' },
    ),
  );

  assert.equal(settleCalls.length, 1);
  assert.equal(received.length, 2);
  assert.equal(received[0], compactions[0], 'compaction observations must not be rebuilt');
  assert.equal(received[1], compactions[1]);
  assert.deepEqual(received, compactions);
});
