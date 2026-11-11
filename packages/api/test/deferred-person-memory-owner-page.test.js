import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { listOwnerDeferredPersonMemoryPage } from '../src/domains/memory/deferred-person-memory-owner-read.ts';
import { DeferredPersonMemoryReceiptKeys } from '../src/domains/memory/deferred-person-memory-redis-contract.ts';

const owner = 'owner-page';
const receipt = (char) => ({
  receiptId: `deferred_person_${char.repeat(32)}`,
  ownerUserId: owner,
  requesterCatId: 'codex61-sol',
  dedupeHash: char.repeat(64),
  state: 'withdrawn',
  retention: 'owner_controlled_no_ttl',
  createdAt: 10,
  updatedAt: 20,
});
function scanClient(windows, records) {
  const calls = [];
  const recordsByKey = new Map(
    records.map((record) => [DeferredPersonMemoryReceiptKeys.receipt(owner, record.receiptId), JSON.stringify(record)]),
  );
  return {
    calls,
    client: {
      options: { keyPrefix: 'owner-page-test:' },
      scan: async (...args) => {
        calls.push(args);
        const window = windows[calls.length - 1];
        assert.ok(window, 'must stop within the supplied scan work budget');
        return [
          window.cursor,
          window.records.map(
            (record) => `owner-page-test:${DeferredPersonMemoryReceiptKeys.receipt(owner, record.receiptId)}`,
          ),
        ];
      },
      get: async (key) => recordsByKey.get(key) ?? null,
    },
  };
}

describe('owner deferred receipt scan pages', () => {
  it('traverses empty scan windows in one page to find actual owner receipts', async () => {
    const first = receipt('a');
    const { client, calls } = scanClient(
      [
        { cursor: '19', records: [] },
        { cursor: '0', records: [first] },
      ],
      [first],
    );
    const result = await listOwnerDeferredPersonMemoryPage(client, owner, { cursor: '0', limit: 20 });
    assert.deepEqual(
      result.entries.map((entry) => entry.receiptId),
      [first.receiptId],
    );
    assert.equal(result.nextCursor, null);
    assert.equal(calls[1][0], '19');
  });
  it('keeps every matching record in a scan window even when COUNT exceeds a display page', async () => {
    const records = ['a', 'b', 'c'].map(receipt);
    const { client, calls } = scanClient([{ cursor: '42', records }], records);
    const result = await listOwnerDeferredPersonMemoryPage(client, owner, { limit: 2 });
    assert.deepEqual(
      result.entries.map((entry) => entry.receiptId),
      records.map((entry) => entry.receiptId),
    );
    assert.equal(result.nextCursor, '42');
    assert.equal(calls.length, 1);
  });
  it('bounds work on sparse keyspaces and preserves the exact nonterminal continuation', async () => {
    const windows = Array.from({ length: 20 }, (_, i) => ({ cursor: String(i + 1), records: [] }));
    const { client, calls } = scanClient(windows, []);
    const result = await listOwnerDeferredPersonMemoryPage(client, owner, { limit: 20 });
    assert.ok(calls.length > 1);
    assert.ok(calls.length <= 10);
    assert.ok(calls.reduce((sum, args) => sum + Number(args[4]), 0) <= 2000);
    assert.deepEqual(result.entries, []);
    assert.equal(result.nextCursor, windows[calls.length - 1].cursor);
  });
});
