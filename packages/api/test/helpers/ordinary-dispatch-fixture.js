import assert from 'node:assert/strict';
import { InMemoryQueueLedgerStore } from '../../dist/domains/cats/services/agents/invocation/queue-ledger/InMemoryQueueLedgerStore.js';
import { createCanonicalLiveSourceFixture } from './1398-live-source-fixture.mjs';

export async function ordinaryDispatchFixture(t) {
  const ledgerStore = new InMemoryQueueLedgerStore();
  const f = await createCanonicalLiveSourceFixture(
    { requested: 'continue_current', boundParentInvocationId: 'live-parent' },
    'agent',
    { ordinary: true, targetCats: ['codex-astra'], ledgerStore },
  );
  t.after(f.close);
  assert.equal(f.turns.get(f.auth.invocationId).queueCompletionPolicy, undefined);
  const headers = { 'x-invocation-id': f.auth.invocationId, 'x-callback-token': f.auth.callbackToken };
  async function get(path, auth = headers) {
    return f.app.inject({ method: 'GET', url: path, headers: auth });
  }
  async function addSource(content) {
    return (
      await f.queue.send(
        f.store,
        {
          threadId: 'home',
          userId: 'owner',
          from: { kind: 'agent', catId: 'opus' },
          content,
          mentions: ['codex-astra'],
          timestamp: Date.now(),
          deliveryStatus: 'queued',
        },
        {
          kind: 'conversation_input',
          threadId: 'home',
          userId: 'owner',
          from: { kind: 'agent', catId: 'opus' },
          ownerAuthProvenance: 'strict',
          content,
          targetCats: ['codex-astra'],
          intent: 'execute',
          authorIntentByCatId: {
            'codex-astra': { requested: 'continue_current', boundParentInvocationId: 'live-parent' },
          },
        },
      )
    ).message;
  }
  return { ...f, ledgerStore, headers, get, addSource };
}
