import assert from 'node:assert/strict';
import { test } from 'node:test';
import { InvocationQueue } from '../dist/domains/cats/services/agents/invocation/InvocationQueue.js';
import { queueHttpFixture } from './helpers/1398-queue-http-fixture.js';
import { runDispatch, waitFor } from './helpers/issue1862-dispatch-fixture.js';
import { runPrestartFailure } from './helpers/issue1862-prestart-fixture.js';

for (const [reason, processing, sibling] of [
  ['control_plane_unavailable', false, false],
  ['prestart_timeout', true, false],
  ['execution_owner_lost', true, true],
]) {
  test(`an A2A prestart ${reason} preserves one result and caller wake across recovery`, async (t) => {
    const fixture = await queueHttpFixture(t);
    if (!processing) {
      const commit = fixture.messages.commitLifecyclePreAdmissionFailure.bind(fixture.messages);
      fixture.messages.commitLifecyclePreAdmissionFailure = (input) => {
        const withoutClaim = commit({ ...input, claim: { ...input.claim, id: undefined } });
        assert.equal(withoutClaim.kind, 'conflict', 'a live ledger target cannot use retired-attempt settlement');
        return commit(input);
      };
    }
    const f = await runPrestartFailure(t, { f: fixture, reason, processing, sibling });
    assert.equal(f.outcome, 'retired');
    const failures = (await f.messages.getByThread(f.threadId)).filter(
      (message) => message.lifecycle?.kind === 'delivery_failure',
    );
    assert.equal(failures.length, 1);
    assert.equal(failures[0].lifecycle.reason, reason);
    const [ref] = (await f.messages.getById(f.source.id)).lifecycle.dispatchRefs;
    assert.deepEqual([ref.targetId, ref.phase, ref.statusMessageId], ['gemini', 'settled', failures[0].id]);
    const pending = await f.queue.getDurableEntry(f.threadId, f.entry.id);
    assert.deepEqual(pending?.targets ?? [], sibling ? ['opus'] : []);
    const recovered = new InvocationQueue(f.queue.ledgerStore);
    await recovered.hydrateFromLedger(f.messages);
    const [wake, ...duplicates] = (await recovered.listAllDurable(f.threadId)).filter(
      (row) => row.sourceCategory === 'a2a_failure',
    );
    assert.ok(wake, 'the prestart failure must durably wake its exact caller');
    assert.deepEqual(duplicates, []);
    assert.deepEqual(wake.targets, ['codex']);
    assert.equal(wake.payload.sourceRecordId, failures[0].id);
    await recovered.hydrateFromLedger(f.messages);
    assert.deepEqual(
      (await recovered.listAllDurable(f.threadId))
        .filter((row) => row.sourceCategory === 'a2a_failure')
        .map((row) => row.id),
      [wake.id],
    );
  });
}

test('a terminal caller identity rejection retires its failure wake without a second result or retry', async (t) => {
  const f = await runDispatch(t);
  const [wake] = await f.queue.listAllDurable(f.threadId);
  const failureId = wake.payload.sourceRecordId;
  const caller = f.agents.get(f.caller);
  caller.implementationSnapshot = () => ({ key: 'fixture:wrong-caller', generation: 'fixture', clientId: 'kimi' });
  f.router.refreshFromRegistry(f.agents);
  f.invocationTracker.complete(f.threadId, f.caller);

  await f.processor.processNext(f.threadId, f.userId);
  await waitFor(async () => (await f.queue.getDurableEntry(f.threadId, wake.id))?.status !== 'claimed');
  assert.equal(await f.queue.getDurableEntry(f.threadId, wake.id), null);
  await f.processor.requestDrain(f.threadId);
  assert.deepEqual(await f.queue.listAllDurable(f.threadId), []);
  const history = await f.messages.getByThread(f.threadId);
  assert.deepEqual(
    history.filter((row) => row.lifecycle?.kind === 'delivery_failure').map((row) => row.id),
    [failureId],
  );
  assert.equal(history.filter((row) => row.lifecycle?.kind === 'response').length, 0);
  assert.equal(f.frames.filter((frame) => frame.type === 'error').length, 0);
  await waitFor(() =>
    f.invocationRecordStore
      .listLatestTerminalByThreadIds([f.threadId], f.userId)
      .get(f.threadId)
      ?.targetCats.includes(f.caller),
  );
  const record = f.invocationRecordStore.listLatestTerminalByThreadIds([f.threadId], f.userId).get(f.threadId);
  assert.equal(
    record.error,
    `a2a_failure_undeliverable:${failureId}:execution_binding_conflict`,
    JSON.stringify(record),
  );
});
