// Session events preserve native identity, text mode and outcome semantics.
//
// A `pending_first_input` implementation reports its native id late,
// and that event becomes a `session_init` carrying the native id.
// The two textMode layers survive the projection unchanged.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AgentSessionBridgeService } from '../../dist/domains/cats/services/agents/session-contract/AgentSessionBridgeService.js';
import { projectSessionEvent } from '../../dist/domains/cats/services/agents/session-contract/event-projection.js';
import { collect, createFakeProvider } from './fake-provider.js';

const HOST_SESSION_ID = 'host-session-1';
const TURN = { invocationId: 'inv-1', nativeTurnId: 'turn-1' };

function ctx(overrides = {}) {
  return {
    catId: 'cat-1',
    metadata: { provider: 'fake-provider', model: 'fake-model', ...overrides },
  };
}

test('[6] native_bound projects to session_init with the native id, and sets metadata.sessionId', () => {
  const context = ctx();
  const messages = projectSessionEvent(
    { scope: 'session', sessionId: HOST_SESSION_ID, seq: 1, type: 'native_bound', nativeSessionId: 'native-9' },
    context,
  );

  assert.equal(messages.length, 1);
  assert.equal(messages[0].type, 'session_init');
  assert.equal(messages[0].sessionId, 'native-9');
  assert.equal(messages[0].metadata.sessionId, 'native-9');
  assert.equal(context.metadata.sessionId, 'native-9');
});

test('[6] a pending_first_input session emits session_init when native_bound arrives mid-turn', async () => {
  const { provider, calls } = createFakeProvider({
    continuityEvidence: 'none',
    binding: { state: 'pending_first_input' },
    events: (turnCtx) => [
      {
        scope: 'session',
        sessionId: turnCtx.sessionId,
        seq: 1,
        type: 'native_bound',
        nativeSessionId: 'native-late',
      },
      {
        scope: 'turn',
        sessionId: turnCtx.sessionId,
        turn: turnCtx.turn,
        seq: 2,
        type: 'output',
        text: 'hi',
        textMode: 'append',
      },
      { scope: 'turn', sessionId: turnCtx.sessionId, turn: turnCtx.turn, seq: 3, type: 'done', outcome: 'completed' },
    ],
  });
  const service = new AgentSessionBridgeService({
    catId: 'cat-1',
    provider,
    resolveHostSession: () => ({ sessionId: HOST_SESSION_ID }),
    resolveMcpServers: () => [],
  });

  const messages = await collect(service.invoke('p', { invocationId: 'inv-1' }));

  assert.equal(calls.openSession[0].sessionId, HOST_SESSION_ID);
  assert.deepEqual(
    messages.map((m) => m.type),
    ['session_init', 'text', 'done'],
  );
  assert.equal(messages[0].sessionId, 'native-late');
  assert.equal(messages[0].metadata.sessionId, 'native-late');
});

test('[6] continuity and compaction_observed session events produce no AgentMessage', () => {
  const continuity = projectSessionEvent(
    {
      scope: 'session',
      sessionId: HOST_SESSION_ID,
      seq: 1,
      type: 'continuity',
      evidence: { kind: 'started', runtimeSessionId: 'native-1' },
    },
    ctx(),
  );
  const compaction = projectSessionEvent(
    {
      scope: 'session',
      sessionId: HOST_SESSION_ID,
      seq: 2,
      type: 'compaction_observed',
      observation: { eventId: 'c1', runtimeSessionId: 'native-1', evidenceRef: 'e1' },
    },
    ctx(),
  );

  assert.deepEqual(continuity, []);
  assert.deepEqual(compaction, []);
});

test('[7] output keeps textMode replace and projects the native message boundary', () => {
  const messages = projectSessionEvent(
    {
      scope: 'turn',
      sessionId: HOST_SESSION_ID,
      turn: TURN,
      seq: 1,
      type: 'output',
      text: 'corrected snapshot',
      textMode: 'replace',
      message: {
        nativeId: 'native-message-1',
        channel: 'final',
        complete: true,
        textMode: 'replace',
        displayPrefixLength: 2,
      },
    },
    ctx({ sessionId: 'native-1' }),
  );

  assert.equal(messages.length, 1);
  const [message] = messages;
  assert.equal(message.type, 'text');
  assert.equal(message.content, 'corrected snapshot');
  assert.equal(message.textMode, 'replace');
  assert.deepEqual(message.outputMessage, {
    provider: 'fake-provider',
    runtimeSessionId: 'native-1',
    turnId: 'turn-1',
    nativeId: 'native-message-1',
    channel: 'final',
    complete: true,
    textMode: 'replace',
    displayPrefixLength: 2,
  });
  assert.equal(message.catId, 'cat-1');
  assert.equal(typeof message.timestamp, 'number');
});

test('[7] an output without a native message carries no outputMessage', () => {
  const [message] = projectSessionEvent(
    {
      scope: 'turn',
      sessionId: HOST_SESSION_ID,
      turn: TURN,
      seq: 1,
      type: 'output',
      text: 'delta',
      textMode: 'append',
    },
    ctx({ sessionId: 'native-1' }),
  );

  assert.equal(message.type, 'text');
  assert.equal(message.textMode, 'append');
  assert.equal(message.outputMessage, undefined);
});

test('[7] the bridge carries textMode replace through to AgentMessage unchanged', async () => {
  const { provider } = createFakeProvider({
    continuityEvidence: 'none',
    events: (turnCtx) => [
      {
        scope: 'turn',
        sessionId: turnCtx.sessionId,
        turn: turnCtx.turn,
        seq: 1,
        type: 'output',
        text: 'snapshot',
        textMode: 'replace',
        message: { nativeId: 'native-message-1', channel: 'final', complete: true, textMode: 'replace' },
      },
      { scope: 'turn', sessionId: turnCtx.sessionId, turn: turnCtx.turn, seq: 2, type: 'done', outcome: 'completed' },
    ],
  });
  const service = new AgentSessionBridgeService({
    catId: 'cat-1',
    provider,
    resolveHostSession: () => ({ sessionId: HOST_SESSION_ID }),
    resolveMcpServers: () => [],
  });

  const messages = await collect(service.invoke('p', { invocationId: 'inv-1' }));
  const [text] = messages;

  assert.equal(text.type, 'text');
  assert.equal(text.textMode, 'replace');
  assert.equal(text.outputMessage.nativeId, 'native-message-1');
  assert.equal(text.outputMessage.turnId, 'turn-1');
  assert.equal(text.outputMessage.provider, text.metadata.provider);
});

test('[7] input_read produces no AgentMessage; context only updates metadata', () => {
  const context = ctx();
  const usage = { inputTokens: 10, outputTokens: 4, totalTokens: 14 };

  assert.deepEqual(
    projectSessionEvent(
      {
        scope: 'turn',
        sessionId: HOST_SESSION_ID,
        turn: TURN,
        seq: 1,
        type: 'input_read',
        deliveryId: 'delivery-1',
      },
      context,
    ),
    [],
  );

  assert.deepEqual(
    projectSessionEvent(
      {
        scope: 'session',
        sessionId: HOST_SESSION_ID,
        seq: 2,
        type: 'context',
        usage,
        windowTokens: 200000,
        model: 'other-model',
      },
      context,
    ),
    [],
  );
  assert.deepEqual(context.metadata.usage, usage);
  assert.equal(context.metadata.model, 'other-model');
});

test('[7] tool_call, tool_result and status project as agreed', () => {
  const toolCall = projectSessionEvent(
    {
      scope: 'turn',
      sessionId: HOST_SESSION_ID,
      turn: TURN,
      seq: 1,
      type: 'tool_call',
      callId: 'call-1',
      name: 'read_file',
      input: { path: 'a.txt' },
    },
    ctx(),
  )[0];
  assert.equal(toolCall.type, 'tool_use');
  assert.equal(toolCall.toolName, 'read_file');
  assert.equal(toolCall.toolUseId, 'call-1');
  assert.deepEqual(toolCall.toolInput, { path: 'a.txt' });

  const scalarToolCall = projectSessionEvent(
    { scope: 'turn', sessionId: HOST_SESSION_ID, turn: TURN, seq: 2, type: 'tool_call', name: 'ping', input: 'raw' },
    ctx(),
  )[0];
  assert.deepEqual(scalarToolCall.toolInput, { value: 'raw' });

  const stringResult = projectSessionEvent(
    {
      scope: 'turn',
      sessionId: HOST_SESSION_ID,
      turn: TURN,
      seq: 3,
      type: 'tool_result',
      callId: 'call-1',
      name: 'read_file',
      status: 'ok',
      output: 'file body',
    },
    ctx(),
  )[0];
  assert.equal(stringResult.type, 'tool_result');
  assert.equal(stringResult.content, 'file body');
  assert.equal(stringResult.toolUseId, 'call-1');

  const structuredResult = projectSessionEvent(
    {
      scope: 'turn',
      sessionId: HOST_SESSION_ID,
      turn: TURN,
      seq: 4,
      type: 'tool_result',
      name: 'read_file',
      status: 'ok',
      output: { lines: 3 },
    },
    ctx(),
  )[0];
  assert.deepEqual(JSON.parse(structuredResult.content), { lines: 3 });

  const status = projectSessionEvent(
    {
      scope: 'turn',
      sessionId: HOST_SESSION_ID,
      turn: TURN,
      seq: 5,
      type: 'status',
      phase: 'thinking',
      detail: 'reading',
    },
    ctx(),
  )[0];
  assert.equal(status.type, 'status');
  assert.equal(status.content, 'reading');
});

test('[7] error and failed done project the error code', () => {
  const error = projectSessionEvent(
    {
      scope: 'turn',
      sessionId: HOST_SESSION_ID,
      turn: TURN,
      seq: 1,
      type: 'error',
      code: 'boom',
      message: 'provider exploded',
      disposition: 'terminal',
    },
    ctx(),
  )[0];
  assert.equal(error.type, 'error');
  assert.equal(error.error, 'provider exploded');
  assert.equal(error.errorCode, 'boom');

  // Bare cancelled/failed outcomes use the default error code;
  // this only pins that an explicit provider code survives projection untouched.
  const done = projectSessionEvent(
    {
      scope: 'turn',
      sessionId: HOST_SESSION_ID,
      turn: TURN,
      seq: 2,
      type: 'done',
      outcome: 'failed',
      errorCode: 'boom',
    },
    ctx(),
  )[0];
  assert.equal(done.type, 'done');
  assert.equal(done.errorCode, 'boom');
});
