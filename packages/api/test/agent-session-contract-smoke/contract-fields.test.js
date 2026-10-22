// The bridge fills session, turn and metadata fields.
//
// Resume mapping, OpenSessionInput defaults, TurnInput optionals,
// metadata identity and updates.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AgentSessionBridgeService } from '../../dist/domains/cats/services/agents/session-contract/AgentSessionBridgeService.js';
import { collect, createFakeProvider } from './fake-provider.js';

const HOST_SESSION_ID = 'host-session-1';

function bridgeFor(provider, overrides = {}) {
  return new AgentSessionBridgeService({
    catId: 'cat-1',
    provider,
    resolveHostSession: () => ({ sessionId: HOST_SESSION_ID }),
    resolveMcpServers: () => [],
    ...overrides,
  });
}

function turnEvent(ctx, seq, fields) {
  return { scope: 'turn', sessionId: ctx.sessionId, turn: ctx.turn, seq, ...fields };
}

function textTurnEvents(ctx) {
  return [
    turnEvent(ctx, 1, { type: 'output', text: 'ok', textMode: 'append' }),
    turnEvent(ctx, 2, { type: 'done', outcome: 'completed' }),
  ];
}

test('[11] openSession carries instructions and cwd from the invocation options', async () => {
  const { provider, calls } = createFakeProvider({ continuityEvidence: 'none', events: textTurnEvents });
  const service = bridgeFor(provider);

  await collect(
    service.invoke('p', {
      invocationId: 'inv-1',
      systemPrompt: 'SYSTEM PROMPT',
      workingDirectory: '/tmp/workdir',
    }),
  );

  const [open] = calls.openSession;
  assert.equal(open.sessionId, HOST_SESSION_ID);
  assert.equal(open.instructions, 'SYSTEM PROMPT');
  assert.equal(open.cwd, '/tmp/workdir');
  assert.equal(open.model, undefined, 'model is not filled in 1a');
  assert.equal(open.config, undefined, 'config is not filled in 1a');
  assert.equal(open.resume, undefined, 'no resume when the session has no native id');
});

test('[11] openSession defaults instructions to empty and cwd to the process cwd', async () => {
  const { provider, calls } = createFakeProvider({ continuityEvidence: 'none', events: textTurnEvents });
  const service = bridgeFor(provider);

  await collect(service.invoke('p', { invocationId: 'inv-1' }));

  assert.equal(calls.openSession[0].instructions, '');
  assert.equal(calls.openSession[0].cwd, process.cwd());
});

test('[10] the first openSession of a session maps its native resume id with onUnavailable start_new', async () => {
  const { provider, calls } = createFakeProvider({ continuityEvidence: 'none', events: textTurnEvents });
  const service = new AgentSessionBridgeService({
    catId: 'cat-1',
    provider,
    resolveHostSession: () => ({ sessionId: HOST_SESSION_ID, resumeNativeSessionId: 'native-old' }),
    resolveMcpServers: () => [],
  });

  await collect(service.invoke('p', { invocationId: 'inv-1' }));

  assert.deepEqual(calls.openSession[0].resume, {
    nativeSessionId: 'native-old',
    onUnavailable: 'start_new',
  });
});

test('[12] TurnInput passes the tool policy and required tools, and leaves deliveryId/images unset', async () => {
  const toolExecutionPolicy = { mode: 'read_only', replayDeniedToolNames: ['shell'] };
  const { provider, calls } = createFakeProvider({ continuityEvidence: 'none', events: textTurnEvents });
  const service = bridgeFor(provider);

  await collect(
    service.invoke('p', {
      invocationId: 'inv-1',
      toolExecutionPolicy,
      requiredTools: ['server::tool'],
    }),
  );

  const input = calls.startTurn[0].input;
  assert.deepEqual(input.invocation.toolExecutionPolicy, toolExecutionPolicy);
  assert.deepEqual(input.invocation.requiredTools, ['server::tool']);
  assert.equal(input.deliveryId, undefined, 'the invoke path has no delivery id source in 1a');
  assert.equal(input.images, undefined, 'images are 1b work');
});

test('[13] AgentMessages default to the session-contract metadata', async () => {
  const { provider } = createFakeProvider({ continuityEvidence: 'none', events: textTurnEvents });
  const service = bridgeFor(provider);

  const messages = await collect(service.invoke('p', { invocationId: 'inv-1' }));

  assert.equal(messages[0].metadata.provider, 'session-contract');
  assert.equal(messages[0].metadata.model, 'unknown');
});

test('[13] the injected metadata replaces the default', async () => {
  const { provider } = createFakeProvider({ continuityEvidence: 'none', events: textTurnEvents });
  const service = bridgeFor(provider, { metadata: { provider: 'acme', model: 'acme-1' } });

  const messages = await collect(service.invoke('p', { invocationId: 'inv-1' }));

  assert.equal(messages[0].metadata.provider, 'acme');
  assert.equal(messages[0].metadata.model, 'acme-1');
});

test('[13] each message gets a shallow copy of the metadata as it was at that moment', async () => {
  const usage = { inputTokens: 11, outputTokens: 5, totalTokens: 16 };
  const { provider } = createFakeProvider({
    continuityEvidence: 'none',
    events: (ctx) => [
      turnEvent(ctx, 1, { type: 'output', text: 'before', textMode: 'append' }),
      { scope: 'session', sessionId: ctx.sessionId, seq: 2, type: 'context', model: 'model-2', usage },
      turnEvent(ctx, 3, { type: 'output', text: 'after', textMode: 'append' }),
      turnEvent(ctx, 4, { type: 'done', outcome: 'completed' }),
    ],
  });
  const service = bridgeFor(provider);

  const messages = await collect(service.invoke('p', { invocationId: 'inv-1' }));
  const [before, after] = messages;

  assert.equal(before.metadata.model, 'unknown');
  assert.equal(before.metadata.usage, undefined);
  assert.equal(after.metadata.model, 'model-2');
  assert.deepEqual(after.metadata.usage, usage);
  assert.notEqual(before.metadata, after.metadata, 'metadata must be copied, not shared');
});
