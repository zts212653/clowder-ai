// Done events carry explicit outcome codes and terminate the stream.
//
// The errorCode a `done` carries is decided, not inferred by callers.
// Every call ends with exactly one `done`, and nothing follows it.
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

function turnEvent(ctx, seq, fields) {
  return { scope: 'turn', sessionId: ctx.sessionId, turn: ctx.turn, seq, ...fields };
}

test('[8] a provider done ends the turn and everything after it is dropped', async () => {
  const { provider } = createFakeProvider({
    continuityEvidence: 'none',
    events: (ctx) => [
      turnEvent(ctx, 1, { type: 'output', text: 'first', textMode: 'append' }),
      turnEvent(ctx, 2, { type: 'done', outcome: 'completed' }),
      turnEvent(ctx, 3, { type: 'output', text: 'after-done', textMode: 'append' }),
      turnEvent(ctx, 4, { type: 'error', code: 'late', message: 'late error', disposition: 'terminal' }),
      turnEvent(ctx, 5, { type: 'done', outcome: 'failed', errorCode: 'late' }),
    ],
  });
  const service = bridgeFor(provider);

  const messages = await collect(service.invoke('p', { invocationId: 'inv-1' }));

  assert.deepEqual(
    messages.map((m) => m.type),
    ['text', 'done'],
  );
  assert.equal(messages.filter((m) => m.type === 'done').length, 1);
  assert.equal(messages.at(-1).errorCode, undefined, 'completed carries no errorCode');
});

test('[8] a provider stream that ends without done gets exactly one bridge-supplied done', async () => {
  const { provider } = createFakeProvider({
    continuityEvidence: 'none',
    events: (ctx) => [turnEvent(ctx, 1, { type: 'output', text: 'hi', textMode: 'append' })],
  });
  const service = bridgeFor(provider);

  const messages = await collect(service.invoke('p', { invocationId: 'inv-1' }));

  assert.deepEqual(
    messages.map((m) => m.type),
    ['text', 'done'],
  );
  assert.equal(messages.at(-1).errorCode, 'provider_stream_ended_without_done');
});

test('[8] an empty provider stream still ends with exactly one done', async () => {
  const { provider } = createFakeProvider({ continuityEvidence: 'none' });
  const service = bridgeFor(provider);

  const messages = await collect(service.invoke('p', { invocationId: 'inv-1' }));

  assert.deepEqual(
    messages.map((m) => m.type),
    ['done'],
  );
  assert.equal(messages[0].errorCode, 'provider_stream_ended_without_done');
});

test('[7] done error codes follow the agreed defaults', async () => {
  const cases = [
    { event: { outcome: 'cancelled' }, expected: 'cancelled' },
    { event: { outcome: 'failed' }, expected: 'failed' },
    { event: { outcome: 'failed', errorCode: 'provider_specific' }, expected: 'provider_specific' },
    { event: { outcome: 'cancelled', errorCode: 'provider_specific' }, expected: 'provider_specific' },
    { event: { outcome: 'completed' }, expected: undefined },
  ];

  for (const { event, expected } of cases) {
    const { provider } = createFakeProvider({
      continuityEvidence: 'none',
      events: (ctx) => [turnEvent(ctx, 1, { type: 'done', ...event })],
    });
    const service = bridgeFor(provider);

    const messages = await collect(service.invoke('p', { invocationId: 'inv-1' }));

    assert.deepEqual(
      messages.map((m) => m.type),
      ['done'],
      `done only for ${JSON.stringify(event)}`,
    );
    assert.equal(messages[0].errorCode, expected, `errorCode for ${JSON.stringify(event)}`);
  }
});
