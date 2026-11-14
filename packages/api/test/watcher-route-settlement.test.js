import assert from 'node:assert/strict';
import { test } from 'node:test';
import { watcherWorld } from './helpers/watcher-world.js';

for (const route of ['serial', 'parallel']) {
  test(`${route}: cancellation settles the child's retained partial reply`, async () => {
    const w = await watcherWorld();
    const records = await w.work('partial reply before cancellation', { route, cancel: true });
    assert.equal(records.length, 1);
    assert.equal(records[0].status, 'canceled');
    assert.equal(records[0].responseSettlement.kind, 'message');
  });
  test(`${route}: a failed provider child still settles its actual persisted failure reply`, async () => {
    const w = await watcherWorld();
    const records = await w.work('partial reply', { route, failure: new Error('fixture provider failed') });
    assert.equal(records.length, 1);
    assert.equal(records[0].status, 'failed');
    assert.equal(records[0].responseSettlement.kind, 'message');
    const message = await w.messages.getById(records[0].responseSettlement.messageId);
    assert.equal(message.extra.turnExecution.invocationId, records[0].invocationId);
  });
  test(`${route}: ordinary replies without @ and empty turns settle each actual child with its own persisted source`, async () => {
    const w = await watcherWorld();
    const records = await w.work('An ordinary reply without a mention.', { route, targets: ['codex', 'opus'] });
    assert.equal(records.length, 2);
    for (const record of records) {
      assert.equal(record.status, 'succeeded');
      assert.equal(record.executionKind, 'ordinary');
      assert.equal(record.responseSettlement.kind, 'message');
      const response = await w.messages.getById(record.responseSettlement.messageId);
      assert.equal(response.extra.turnExecution.invocationId, record.invocationId);
      assert.ok(record.providerTeardownAt >= record.startedAt);
    }
    const empty = await w.work('', { route });
    assert.equal(empty.length, 1);
    assert.equal(empty[0].responseSettlement.kind, 'no_response');
  });
}

test('serial: the first child settles before the next child begins, without waiting for the parent route', async () => {
  const w = await watcherWorld();
  let first;
  await w.work('plain', {
    targets: ['codex', 'opus'],
    observe: async (catId) => {
      if (catId === 'opus')
        first = (await w.executions.listSettled({ userId: 'watcher-owner', threadId: w.thread.id })).records[0];
    },
  });
  assert.equal(first?.catId, 'codex');
  assert.equal(first?.responseSettlement.kind, 'message');
});
