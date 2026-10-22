// Cancellation reaches the provider and suppresses late turn content.
//
// `options.signal` abort must reach the provider as `cancelTurn(..., 'abort')`,
// and nothing that arrives afterwards may surface as turn content.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AgentSessionBridgeService } from '../../dist/domains/cats/services/agents/session-contract/AgentSessionBridgeService.js';
import { AsyncInbox, collectIterator, createFakeProvider, waitFor } from './fake-provider.js';

const HOST_SESSION_ID = 'host-session-1';
const TURN_REF = { invocationId: 'inv-1', nativeTurnId: 'turn-1' };

function textEvent(text, seq) {
  return { scope: 'turn', sessionId: HOST_SESSION_ID, turn: TURN_REF, seq, type: 'output', text, textMode: 'append' };
}

test('[extra] abort calls cancelTurn and drops everything the provider emits afterwards', async () => {
  const inbox = new AsyncInbox();
  const { provider, calls } = createFakeProvider({ continuityEvidence: 'none', events: inbox });
  const service = new AgentSessionBridgeService({
    catId: 'cat-1',
    provider,
    resolveHostSession: () => ({ sessionId: HOST_SESSION_ID }),
    resolveMcpServers: () => [],
  });
  const controller = new AbortController();

  const stream = service.invoke('p', { invocationId: 'inv-1', signal: controller.signal });
  const iterator = stream[Symbol.asyncIterator]();
  const firstMessage = iterator.next();
  await waitFor(() => calls.startTurn.length === 1, 'startTurn');

  inbox.push(textEvent('before-abort', 1));
  const first = await firstMessage;
  assert.equal(first.value.type, 'text');
  assert.equal(first.value.content, 'before-abort');

  controller.abort();

  // These arrive strictly after the abort; none of them may surface.
  inbox.push(textEvent('after-abort', 2));
  inbox.push({ scope: 'turn', sessionId: HOST_SESSION_ID, turn: TURN_REF, seq: 3, type: 'done', outcome: 'completed' });

  await waitFor(() => calls.cancelTurn.length === 1, 'cancelTurn');

  assert.equal(calls.cancelTurn[0].sessionId, HOST_SESSION_ID);
  assert.equal(calls.cancelTurn[0].expected.invocationId, 'inv-1');
  assert.equal(calls.cancelTurn[0].reason, 'abort');

  inbox.close();
  const rest = await collectIterator(iterator);

  assert.deepEqual(
    rest.map((m) => m.type),
    ['done'],
    'abort produces no error, only a done',
  );
  // The bridge's own done wins, and the provider's later done is dropped.
  assert.equal(rest.at(-1).errorCode, 'cancelled');
});
