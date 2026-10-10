import assert from 'node:assert/strict';
import { test } from 'node:test';
import { InvocationQueue } from '../src/domains/cats/services/agents/invocation/InvocationQueue.ts';
import { InMemoryQueueLedgerStore } from '../src/domains/cats/services/agents/invocation/queue-ledger/InMemoryQueueLedgerStore.ts';
import { settleLifecycleResponseInputs } from '../src/domains/cats/services/stores/ports/MessageStore.ts';
import {
  assertDeliveredLiveSource as delivered,
  createCanonicalLiveSourceFixture as fixture,
} from './helpers/1398-live-source-fixture.mjs';

const intent = { requested: 'continue_current', boundParentInvocationId: 'live-parent' };
// Canonical response + source dispatchRef replace the old adopted-disposition
// event and secondary receipt. Delivery must never complete business work.
for (const status of ['completed', 'failed', 'interrupted']) {
  test('one admitted Live response owns its source through terminal and cold Queue hydration: ' + status, async (t) => {
    const ledgerStore = new InMemoryQueueLedgerStore();
    const f = await fixture(intent, 'agent', { ledgerStore });
    t.after(f.close);
    assert.equal((await f.read()).statusCode, 200);
    await delivered(f);
    const terminal = await f.store.commitLifecycleResponseTerminal(f.response.id, {
      invocationId: f.auth.invocationId,
      status,
      completedAt: Date.now(),
      content: status === 'completed' ? 'one result' : '',
      reason: 'fixture_' + status,
      extra: f.response.extra,
      mentions: [],
      origin: 'stream',
    });
    assert.equal(terminal.kind, 'applied');
    await settleLifecycleResponseInputs(f.store, terminal.message, f.response.id);
    const input = f.store.getById(f.message.id);
    assert.equal(input.lifecycle.dispatchRefs.length, 1);
    assert.equal(input.lifecycle.dispatchRefs[0].statusMessageId, f.response.id);
    const restarted = new InvocationQueue(ledgerStore);
    await restarted.hydrateFromLedger(f.store);
    assert.deepEqual(
      restarted.list('home', 'owner').map((e) => e.targets),
      [['kimi']],
    );
    await restarted.hydrateFromLedger(f.store);
    assert.deepEqual(
      restarted.list('home', 'owner').map((e) => e.targets),
      [['kimi']],
    );
    assert.equal(f.store.getByThread('home', 30, 'owner').filter((m) => m.lifecycle?.kind === 'response').length, 1);
    assert.equal(f.store.getByThread('home', 30, 'owner').filter((m) => m.from.kind === 'system').length, 0);
  });
}

test('lost History admission acknowledgement reads back the original response and never resurrects its delivered target', async (t) => {
  const f = await fixture(intent, 'agent');
  t.after(f.close);
  const commit = f.store.commitLifecycleAppendAdmission.bind(f.store);
  let commits = 0;
  f.store.commitLifecycleAppendAdmission = async (input) => {
    await commit(input);
    commits++;
    throw new Error('fixture acknowledgement lost after commit');
  };
  const failed = await f.read();
  assert.equal(failed.statusCode, 503, failed.body);
  await delivered(f);
  f.store.commitLifecycleAppendAdmission = commit;
  assert.equal((await f.read()).statusCode, 200);
  assert.equal(commits, 1);
  await delivered(f);
  assert.equal(f.store.getByThread('home', 30, 'owner').filter((m) => m.lifecycle?.kind === 'response').length, 1);
});

test('unknown History after lost admission reply preserves the exact claim until canonical cold recovery', async (t) => {
  const ledgerStore = new InMemoryQueueLedgerStore();
  const f = await fixture(intent, 'agent', { ledgerStore });
  t.after(f.close);
  const commit = f.store.commitLifecycleAppendAdmission.bind(f.store);
  const read = f.store.getById.bind(f.store);
  let unavailable = false;
  f.store.getById = (id) => {
    if (unavailable) throw new Error('fixture History unavailable');
    return read(id);
  };
  f.store.commitLifecycleAppendAdmission = async (input) => {
    await commit(input);
    unavailable = true;
    throw new Error('fixture acknowledgement lost after commit');
  };
  assert.equal((await f.read()).statusCode, 503);
  assert.equal(read(f.message.id).lifecycle.dispatchRefs[0].statusMessageId, f.response.id);
  assert.equal((await f.queue.getDurableEntry('home', f.entry.id)).status, 'claimed');
  unavailable = false;
  f.store.commitLifecycleAppendAdmission = commit;
  const restarted = new InvocationQueue(ledgerStore);
  await restarted.hydrateFromLedger(f.store);
  assert.deepEqual(
    restarted.list('home', 'owner').map((e) => e.targets),
    [['kimi']],
  );
  assert.equal(read(f.response.id).lifecycle.status, 'processing');
  assert.equal(read(f.message.id).lifecycle.dispatchRefs.length, 1);
});
