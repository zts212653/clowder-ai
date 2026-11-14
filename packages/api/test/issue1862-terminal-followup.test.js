import assert from 'node:assert/strict';
import { test } from 'node:test';
import { InvocationQueue } from '../dist/domains/cats/services/agents/invocation/InvocationQueue.js';
import { queueHttpFixture } from './helpers/1398-queue-http-fixture.js';
import { runDispatch, waitFor } from './helpers/issue1862-dispatch-fixture.js';
import {
  assertPrestartWithdrawalRace,
  runPrestartFailure,
  settlePrestartSibling,
} from './helpers/issue1862-prestart-fixture.js';

for (const withdrawal of ['group', 'thread', 'replacement']) {
  for (const phase of ['read', 'commit']) {
    test(`prestart ${withdrawal} withdrawal arbitrates with failure during ${phase}`, async (t) => {
      await assertPrestartWithdrawalRace(t, undefined, withdrawal, phase);
    });
  }
}

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

test('a processing group has every failed target settled when its first transaction returns', async (t) => {
  const f = await queueHttpFixture(t);
  const commit = f.messages.commitLifecyclePreAdmissionFailure.bind(f.messages);
  let transactions = 0;
  let committedInput;
  f.messages.commitLifecyclePreAdmissionFailure = (input) => {
    committedInput = input;
    const result = commit(input);
    assert.deepEqual(result.inputMessage.lifecycle.dispatchRefs.map((ref) => ref.targetId).sort(), ['gemini', 'opus']);
    transactions++;
    return result;
  };
  const result = await runPrestartFailure(t, { f, reason: 'prestart_timeout', processing: true, sibling: 'failed' });
  assert.equal(result.outcome, 'retired');
  assert.equal(transactions, 1);
  const failures = (await f.messages.getByThread(f.thread.id)).filter(
    (row) => row.lifecycle?.kind === 'delivery_failure',
  );
  assert.equal(failures.length, 1);
  assert.deepEqual(failures[0].lifecycle.requestedTargets, ['gemini', 'opus']);
  const recovered = new InvocationQueue(f.queue.ledgerStore);
  await recovered.hydrateFromLedger(f.messages);
  assert.equal((await recovered.listAllDurable(f.thread.id)).length, 1);
  const replayed = commit({ ...committedInput, requestedTargets: [...committedInput.requestedTargets].reverse() });
  assert.equal(replayed.kind, 'replayed', 'group identity must not depend on target array order');
});

test('a successful sibling committed during prestart settlement shrinks the failed cohort', async (t) => {
  const f = await runPrestartFailure(t, {
    reason: 'prestart_timeout',
    processing: true,
    sibling: 'failed',
    prepareOnly: true,
  });
  const commit = f.messages.commitLifecyclePreAdmissionFailure.bind(f.messages);
  let raced = false;
  f.messages.commitLifecyclePreAdmissionFailure = async (input) => {
    if (!raced) {
      raced = true;
      await settlePrestartSibling(f, f.source, f.entry);
    }
    return commit(input);
  };
  assert.equal(
    await f.processor.failPrestartProcessingGroup(f.threadId, 'gemini', 'owner', 'prestart_timeout'),
    'retired',
  );
  const failures = (await f.messages.getByThread(f.threadId)).filter(
    (row) => row.lifecycle?.kind === 'delivery_failure',
  );
  assert.equal(failures.length, 1);
  assert.deepEqual(failures[0].lifecycle.requestedTargets, ['gemini']);
  assert.equal(failures[0].content.includes('opus'), false);
});

test('prestart commit acknowledgement loss reprojects the one durable wake on the same worker', async (t) => {
  const f = await runPrestartFailure(t, { reason: 'prestart_timeout', processing: true, prepareOnly: true });
  const commit = f.messages.commitLifecyclePreAdmissionFailure.bind(f.messages);
  f.messages.commitLifecyclePreAdmissionFailure = (input) => {
    commit(input);
    throw new Error('fixture: lost prestart acknowledgement');
  };
  await assert.rejects(
    f.processor.failPrestartProcessingGroup(f.threadId, 'gemini', 'owner', 'prestart_timeout'),
    /lost prestart acknowledgement/,
  );
  f.messages.commitLifecyclePreAdmissionFailure = commit;
  assert.equal(
    await f.processor.failPrestartProcessingGroup(f.threadId, 'gemini', 'owner', 'prestart_timeout'),
    'retired',
  );
  const [wake] = await f.queue.listAllDurable(f.threadId);
  assert.equal(
    f.queue.list(f.threadId, 'owner').some((entry) => entry.id === wake.id),
    true,
  );
});

test('a settled successful sibling does not block prestart retirement or caller drain', async (t) => {
  const f = await runPrestartFailure(t, { reason: 'prestart_timeout', processing: true, sibling: 'settled' });
  assert.equal(f.outcome, 'retired');
  const refs = (await f.messages.getById(f.source.id)).lifecycle.dispatchRefs;
  assert.deepEqual(
    refs.map((ref) => [ref.targetId, ref.statusMessageId]),
    [
      ['opus', 'successful-opus-response'],
      ['gemini', (await f.queue.listAllDurable(f.threadId))[0].payload.sourceRecordId],
    ],
  );
  const failure = await f.messages.getById(refs[1].statusMessageId);
  assert.deepEqual(failure.lifecycle.requestedTargets, ['gemini']);
  assert.equal(failure.content.includes('opus'), false);
});

for (const failedStep of [undefined, 'diagnostic', 'retirement']) {
  test(`a terminal caller identity rejection persists diagnosis before retirement (failedStep=${failedStep})`, async (t) => {
    const f = await runDispatch(t);
    const [wake] = await f.queue.listAllDurable(f.threadId);
    const failureId = wake.payload.sourceRecordId;
    const caller = f.agents.get(f.caller);
    caller.implementationSnapshot = () => ({ key: 'fixture:wrong-caller', generation: 'fixture', clientId: 'kimi' });
    f.router.refreshFromRegistry(f.agents);
    f.invocationTracker.complete(f.threadId, f.caller);

    const terminalError = `a2a_failure_undeliverable:${failureId}:execution_binding_conflict`;
    const update = f.invocationRecordStore.update.bind(f.invocationRecordStore);
    if (failedStep === 'diagnostic') {
      f.invocationRecordStore.update = (id, input) => {
        if (input.error === terminalError) throw new Error('fixture: diagnostic persistence unavailable');
        return update(id, input);
      };
      await f.processor.processNext(f.threadId, f.userId);
      await waitFor(async () => (await f.queue.getDurableEntry(f.threadId, wake.id))?.status !== 'claimed');
      assert.equal(
        (await f.queue.getDurableEntry(f.threadId, wake.id))?.status,
        'queued',
        'diagnostic failure must preserve the wake',
      );
      f.invocationRecordStore.update = update;
    }
    const remove = f.queue.removeProcessedAcrossUsersDurable.bind(f.queue);
    if (failedStep === 'retirement') {
      f.queue.removeProcessedAcrossUsersDurable = async (...args) => {
        if (args[1] === wake.id) throw new Error('fixture: retirement persistence unavailable');
        return remove(...args);
      };
      await f.processor.processNext(f.threadId, f.userId);
      await waitFor(() => !f.invocationTracker.has(f.threadId, f.caller));
      assert.ok(await f.queue.getDurableEntry(f.threadId, wake.id), 'retirement failure must preserve the wake');
      assert.equal(
        f.invocationRecordStore.listLatestTerminalByThreadIds([f.threadId], f.userId).get(f.threadId).error,
        terminalError,
      );
      await f.queue.hydrateFromLedger(f.messages);
    }
    f.queue.removeProcessedAcrossUsersDurable = async (...args) => {
      if (args[1] === wake.id) {
        const record = f.invocationRecordStore.listLatestTerminalByThreadIds([f.threadId], f.userId).get(f.threadId);
        assert.equal(record?.error, terminalError, 'diagnosis must be durable before wake removal');
      }
      return remove(...args);
    };

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
    assert.equal(f.frames.filter((frame) => frame.type === 'error').length, failedStep ? 1 : 0);
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
}
