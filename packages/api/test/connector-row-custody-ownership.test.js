// A connector row admitted for a custody-managed source may stay in the Queue only if
// that durable custody names it as the exact carrier. Anything else can never be
// started — each attempt fails the custody check and rolls back — so it is a poison row.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const { resolveConnectorRowCustodyOwnership } = await import(
  '../dist/domains/cats/services/agents/invocation/connector-row-custody-ownership.js'
);

const row = { id: 'row-new', targetCats: ['cat-a'] };
const custody = (overrides = {}) => ({
  version: 1,
  entryId: 'row-new',
  revision: 1,
  status: 'queued',
  allTargetCats: ['cat-a'],
  pendingTargetCats: ['cat-a'],
  ...overrides,
});

describe('connector row custody ownership', () => {
  test('a source that never had Queue custody is unmanaged: the row is its only carrier', () => {
    assert.equal(resolveConnectorRowCustodyOwnership(null, row), 'unmanaged');
    assert.equal(resolveConnectorRowCustodyOwnership({}, row), 'unmanaged');
    assert.equal(resolveConnectorRowCustodyOwnership({ deliveryStatus: 'delivered' }, row), 'unmanaged');
    assert.equal(resolveConnectorRowCustodyOwnership({ deliveryStatus: 'queued' }, row), 'unmanaged');
  });

  test('live custody that names exactly this row owns it, queued or processing', () => {
    assert.equal(
      resolveConnectorRowCustodyOwnership({ deliveryStatus: 'queued', queueCustody: custody() }, row),
      'owned',
    );
    assert.equal(
      resolveConnectorRowCustodyOwnership(
        { deliveryStatus: 'queued', queueCustody: custody({ status: 'processing' }) },
        row,
      ),
      'owned',
    );
  });

  test('terminal custody admits no carrier, even one it names', () => {
    const finished = custody({ status: 'terminal', pendingTargetCats: [] });
    assert.equal(
      resolveConnectorRowCustodyOwnership({ deliveryStatus: 'delivered', queueCustody: finished }, row),
      'unowned',
    );
    assert.equal(
      resolveConnectorRowCustodyOwnership({ deliveryStatus: 'queued', queueCustody: finished }, row),
      'unowned',
    );
  });

  test('live custody that names another carrier leaves this row unowned', () => {
    const elsewhere = custody({ entryId: 'row-in-another-process' });
    assert.equal(
      resolveConnectorRowCustodyOwnership({ deliveryStatus: 'queued', queueCustody: elsewhere }, row),
      'unowned',
    );
  });

  test('per-target carriers must all name this row', () => {
    const carrier = (entryId) => ({ entryId, source: 'agent', sourceCategory: 'a2a', autoExecute: true, createdAt: 1 });
    const two = { id: 'row-new', targetCats: ['cat-a', 'cat-b'] };
    const both = custody({ carrierByTargetCatId: { 'cat-a': carrier('row-new'), 'cat-b': carrier('row-new') } });
    const split = custody({ carrierByTargetCatId: { 'cat-a': carrier('row-new'), 'cat-b': carrier('row-other') } });
    assert.equal(resolveConnectorRowCustodyOwnership({ deliveryStatus: 'queued', queueCustody: both }, two), 'owned');
    assert.equal(
      resolveConnectorRowCustodyOwnership({ deliveryStatus: 'queued', queueCustody: split }, two),
      'unowned',
    );
  });

  test('a canceled source can never be delivered', () => {
    assert.equal(resolveConnectorRowCustodyOwnership({ deliveryStatus: 'canceled' }, row), 'unowned');
  });
});
