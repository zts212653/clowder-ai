/**
 * K-1 / F258 — idempotent settlement ledger state machine (plan Task 2, §4a)
 * unclaimed → inflight → settled | released; claim-TTL expiry; instance scoping (AC-5).
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';

/** @type {typeof import('../dist/domains/messaging/stores/memory.js')} */
let memory;
/** @type {typeof import('../dist/domains/messaging/ledger.js')} */
let ledgerMod;

let originalDateNow;
let now;

beforeEach(async () => {
  memory = await import('../dist/domains/messaging/stores/memory.js');
  ledgerMod = await import('../dist/domains/messaging/ledger.js');
  originalDateNow = Date.now;
  now = 1_800_000_000_000;
  Date.now = () => now;
});

afterEach(() => {
  Date.now = originalDateNow;
});

const CLAIM_TTL = 60_000;
const RETENTION = 7 * 24 * 3600 * 1000;

describe('MemoryLedgerStore state machine (§4a)', () => {
  test('claim on unclaimed key returns new; second claim while inflight returns inflight', async () => {
    const store = new memory.MemoryLedgerStore();
    const first = await store.claim('k1', CLAIM_TTL);
    assert.equal(first.status, 'new');
    assert.equal(typeof first.claimToken, 'string');
    const second = await store.claim('k1', CLAIM_TTL);
    assert.deepEqual(second, { status: 'inflight' });
  });

  test('settle transitions to settled; later claims return the same receipt (INV-1)', async () => {
    const store = new memory.MemoryLedgerStore();
    const claim = await store.claim('k1', CLAIM_TTL);
    await store.settle('k1', claim.claimToken, { messageId: 'm-1', revision: 1 }, RETENTION);
    const again = await store.claim('k1', CLAIM_TTL);
    assert.equal(again.status, 'settled');
    assert.deepEqual(again.receipt, { messageId: 'm-1', revision: 1 });
  });

  test('settle is idempotent (keeps first receipt)', async () => {
    const store = new memory.MemoryLedgerStore();
    const initial = await store.claim('k1', CLAIM_TTL);
    await store.settle('k1', initial.claimToken, { messageId: 'first' }, RETENTION);
    await store.settle('k1', initial.claimToken, { messageId: 'second' }, RETENTION);
    const claim = await store.claim('k1', CLAIM_TTL);
    assert.equal(claim.status, 'settled');
    assert.deepEqual(claim.receipt, { messageId: 'first' });
  });

  test('release returns key to unclaimed so retry can re-execute (fail path)', async () => {
    const store = new memory.MemoryLedgerStore();
    const claim = await store.claim('k1', CLAIM_TTL);
    await store.release('k1', claim.claimToken);
    const retry = await store.claim('k1', CLAIM_TTL);
    assert.equal(retry.status, 'new');
  });

  test('release after settle does not erase the settlement (settled is sticky)', async () => {
    const store = new memory.MemoryLedgerStore();
    const initial = await store.claim('k1', CLAIM_TTL);
    await store.settle('k1', initial.claimToken, { messageId: 'm-1' }, RETENTION);
    await store.release('k1', initial.claimToken);
    const claim = await store.claim('k1', CLAIM_TTL);
    assert.equal(claim.status, 'settled');
  });

  test('adversarial: claim-then-crash — inflight orphan re-claimable after claim TTL', async () => {
    const store = new memory.MemoryLedgerStore();
    await store.claim('k1', CLAIM_TTL);
    now += CLAIM_TTL - 1;
    assert.equal((await store.claim('k1', CLAIM_TTL)).status, 'inflight');
    now += 2;
    assert.equal((await store.claim('k1', CLAIM_TTL)).status, 'new');
  });

  test('expired claimant cannot release or settle a successor claim', async () => {
    const store = new memory.MemoryLedgerStore();
    const stale = await store.claim('k1', CLAIM_TTL);
    now += CLAIM_TTL + 1;
    const successor = await store.claim('k1', CLAIM_TTL);

    await store.release('k1', stale.claimToken);
    assert.equal((await store.claim('k1', CLAIM_TTL)).status, 'inflight');
    await store.settle('k1', stale.claimToken, { messageId: 'stale' }, RETENTION);
    assert.equal((await store.claim('k1', CLAIM_TTL)).status, 'inflight');
    await store.settle('k1', successor.claimToken, { messageId: 'winner' }, RETENTION);
    assert.deepEqual((await store.claim('k1', CLAIM_TTL)).receipt, { messageId: 'winner' });
  });

  test('settled entry expires after retention TTL (documented at-least-once boundary)', async () => {
    const store = new memory.MemoryLedgerStore();
    const claim = await store.claim('k1', CLAIM_TTL);
    await store.settle('k1', claim.claimToken, { messageId: 'm-1' }, RETENTION);
    now += RETENTION + 1;
    assert.equal((await store.claim('k1', CLAIM_TTL)).status, 'new');
  });
});

describe('MessagingLedger key scoping (AC-5)', () => {
  test('same idempotencyKey under different instances settles independently', async () => {
    const ledger = new ledgerMod.MessagingLedger(new memory.MemoryLedgerStore());
    const claim = await ledger.claimSend('inst-a', 'idem-1');
    assert.equal(claim.status, 'new');
    await ledger.settleSend('inst-a', 'idem-1', claim.claimToken, {
      messageId: 'm-a',
      threadId: 't',
      revision: 1,
    });
    const other = await ledger.claimSend('inst-b', 'idem-1');
    assert.equal(other.status, 'new');
  });

  test('send and append key spaces do not collide', async () => {
    const ledger = new ledgerMod.MessagingLedger(new memory.MemoryLedgerStore());
    assert.equal((await ledger.claimSend('inst-a', 'x')).status, 'new');
    const append = await ledger.claimAppend('inst-a', 'x', 'x');
    assert.equal(append.status, 'new');
  });

  test('append key scoped by (instance, messageId, operationId) — INV-12 anchor', async () => {
    const ledger = new ledgerMod.MessagingLedger(new memory.MemoryLedgerStore());
    const claim = await ledger.claimAppend('inst-a', 'msg-1', 'op-1');
    assert.equal(claim.status, 'new');
    await ledger.settleAppend('inst-a', 'msg-1', 'op-1', claim.claimToken, {
      messageId: 'msg-1',
      revision: 2,
      appliedElementIds: [],
    });
    assert.equal((await ledger.claimAppend('inst-a', 'msg-1', 'op-1')).status, 'settled');
    assert.equal((await ledger.claimAppend('inst-a', 'msg-1', 'op-2')).status, 'new');
    assert.equal((await ledger.claimAppend('inst-a', 'msg-2', 'op-1')).status, 'new');
    assert.equal((await ledger.claimAppend('inst-b', 'msg-1', 'op-1')).status, 'new');
  });

  test('adversarial: colon-bearing segments cannot forge a foreign key space', async () => {
    const ledger = new ledgerMod.MessagingLedger(new memory.MemoryLedgerStore());
    // If segments were joined naively with ':', these two would collide.
    assert.equal((await ledger.claimAppend('inst', 'm:x', 'op')).status, 'new');
    assert.equal((await ledger.claimAppend('inst', 'm', 'x:op')).status, 'new');
  });

  test('release on failure allows a genuine retry to proceed', async () => {
    const ledger = new ledgerMod.MessagingLedger(new memory.MemoryLedgerStore());
    const claim = await ledger.claimSend('inst-a', 'idem-1');
    await ledger.releaseSend('inst-a', 'idem-1', claim.claimToken);
    assert.equal((await ledger.claimSend('inst-a', 'idem-1')).status, 'new');
  });
});
