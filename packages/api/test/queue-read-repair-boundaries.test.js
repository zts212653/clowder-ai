import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { ActiveExecutionReadRepair } from '../dist/domains/cats/services/agents/invocation/active-execution-read-repair.js';
import { readRepairFixture } from './helpers/read-repair-fixture.js';

test('repair freezes private recipients before its new asynchronous observation; later work and hooks survive', async (t) => {
  const h = await readRepairFixture(t);
  await h.turnExecutionStore.recordProviderTeardown(h.childId, Date.now());
  const enqueue = async (sourceId) =>
    (
      await h.invocationQueue.enqueueDurable({
        kind: 'private_input',
        threadId: h.threadId,
        userId: h.userId,
        sourceId,
        from: { kind: 'system', service: 'worktree-lifecycle' },
        ownerAuthProvenance: 'unknown',
        content: sourceId,
        targetCats: [h.catId],
        intent: 'execute',
        autoExecute: true,
      })
    ).entry;
  const old = await enqueue('before-repair');
  const oldComplete = mock.fn();
  h.queueProcessor.registerEntryCompleteHook(old.id, oldComplete, h.catId);
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  t.after(() => release.resolve());
  const run = ActiveExecutionReadRepair.prototype.run;
  t.mock.method(ActiveExecutionReadRepair.prototype, 'run', function (input) {
    return run.call(this, {
      ...input,
      readChildren: async () => {
        entered.resolve();
        await release.promise;
        return input.readChildren();
      },
    });
  });
  const polling = h.poll();
  await entered.promise;
  const fresh = await enqueue('during-observation');
  const freshComplete = mock.fn();
  h.queueProcessor.registerEntryCompleteHook(fresh.id, freshComplete, h.catId);
  release.resolve();
  await polling;
  assert.equal(h.parent.status, 'failed', 'the proof-backed old execution still repairs');
  assert.equal(await h.invocationQueue.getDurableEntry(h.threadId, old.id), null);
  assert.equal(oldComplete.mock.calls[0].arguments[1], 'canceled_by_user');
  assert.equal(
    (await h.invocationQueue.getDurableEntry(h.threadId, fresh.id))?.status,
    'queued',
    'new private work was never part of the old execution stop snapshot',
  );
  assert.equal(freshComplete.mock.callCount(), 0, 'new work must never receive a spurious cancellation callback');
});

for (const count of [1_024, 1_025]) {
  test(`a stable scan of ${count} failures cannot discard every cooldown at the capacity boundary`, async (t) => {
    t.mock.method(Date, 'now', () => 1_800_000_000_000);
    const coordinator = new ActiveExecutionReadRepair();
    const log = { error: mock.fn(), info: mock.fn() };
    let writes = 0;
    const inputs = Array.from({ length: count }, (_, i) => ({
      record: {
        id: `capacity-${i}`,
        threadId: 'capacity-thread',
        userId: 'capacity-user',
        targetCats: ['opus'],
        status: 'running',
        updatedAt: 0,
      },
      targetCats: ['opus'],
      owners: [],
      readChildren: async () => [],
      log,
      repair: async () => {
        writes += 1;
        throw new Error('provider_teardown_unconfirmed');
      },
    }));
    for (const input of inputs) await coordinator.run(input);
    assert.equal(writes, count, 'all first failures remain observable');
    for (let round = 0; round < 3; round += 1) {
      const before = writes;
      const errorsBefore = log.error.mock.callCount();
      for (const input of inputs) await coordinator.run(input);
      assert.ok(
        writes - before <= (count === 1_024 ? 0 : 2),
        'a one-entry overflow may reprobe, but cannot restart the whole scan',
      );
      assert.ok(
        log.error.mock.callCount() - errorsBefore <= 2,
        'capacity pressure must not bring back a full stack storm',
      );
      assert.ok(coordinator.states.size <= 1_024, 'retry advice remains space-bounded');
    }
    inputs[0].record.updatedAt += 1;
    const beforeChange = writes;
    await coordinator.run(inputs[0]);
    assert.equal(
      writes,
      beforeChange + 1,
      'capacity protection must still allow changed evidence to retry immediately',
    );
  });
}
