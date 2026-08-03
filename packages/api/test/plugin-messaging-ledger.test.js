/**
 * K-1 / F288 — idempotent settlement ledger state machine (plan Task 2, §4a)
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

describe('Claim-expiry overlap — settle boolean (§4a stale-claimant)', () => {
  test('settle returns false when claim has expired', async () => {
    const store = new memory.MemoryLedgerStore();
    const claim = await store.claim('k-stale', CLAIM_TTL);
    // Advance past claim expiry.
    now += CLAIM_TTL + 1;
    const settled = await store.settle('k-stale', claim.claimToken, { messageId: 'late' }, RETENTION);
    assert.equal(settled, false, 'expired claimToken must be rejected');
  });

  test('settle returns true for fresh claimant and already-settled key', async () => {
    const store = new memory.MemoryLedgerStore();
    const claim = await store.claim('k-fresh', CLAIM_TTL);
    const first = await store.settle('k-fresh', claim.claimToken, { messageId: 'winner' }, RETENTION);
    assert.equal(first, true, 'first settle must succeed');
    // Idempotent settle on already-settled key returns true (first receipt sticks).
    const second = await store.settle('k-fresh', claim.claimToken, { messageId: 'ignored' }, RETENTION);
    assert.equal(second, true, 'already-settled must return true');
  });

  test('stale claimant settle rejected while successor is still inflight', async () => {
    // Simulates the claim-expiry overlap: A claims → expires → B claims
    // (inflight) → A tries to settle → rejected (B's token owns the slot).
    const store = new memory.MemoryLedgerStore();
    const claimA = await store.claim('k-race', CLAIM_TTL);
    // Claim A expires.
    now += CLAIM_TTL + 1;
    // Successor B claims (A is expired, so B gets a fresh claim).
    const claimB = await store.claim('k-race', CLAIM_TTL);
    assert.equal(claimB.status, 'new');
    // Stale claimant A tries to settle while B is still inflight — rejected.
    const settledA = await store.settle('k-race', claimA.claimToken, { messageId: 'stale' }, RETENTION);
    assert.equal(settledA, false, 'stale claimant must be rejected while successor is inflight');
    // A re-claims → inflight (B still holds).
    const reClaim = await store.claim('k-race', CLAIM_TTL);
    assert.equal(reClaim.status, 'inflight');
    // B settles successfully.
    const settledB = await store.settle('k-race', claimB.claimToken, { messageId: 'canonical' }, RETENTION);
    assert.equal(settledB, true);
    // Now a re-claim returns the canonical receipt.
    const final = await store.claim('k-race', CLAIM_TTL);
    assert.equal(final.status, 'settled');
    assert.deepEqual(final.receipt, { messageId: 'canonical' });
  });

  test('settle on already-settled key returns true regardless of token (idempotent)', async () => {
    // Once settled, settle() returns true for any caller — "entry is settled" is the
    // only signal. The first receipt is sticky (second receipt ignored).
    const store = new memory.MemoryLedgerStore();
    const claimA = await store.claim('k-idem', CLAIM_TTL);
    await store.settle('k-idem', claimA.claimToken, { messageId: 'winner' }, RETENTION);
    // Advance time but within retention.
    now += CLAIM_TTL + 1;
    // Stale token settle on already-settled → true (idempotent; receipt is winner's).
    const settled = await store.settle('k-idem', 'totally-bogus-token', { messageId: 'ignored' }, RETENTION);
    assert.equal(settled, true, 'already-settled must return true');
    const check = await store.claim('k-idem', CLAIM_TTL);
    assert.deepEqual(check.receipt, { messageId: 'winner' }, 'first receipt sticks');
  });

  test('settle boolean propagates through MessagingLedger.settleSend', async () => {
    const ledger = new ledgerMod.MessagingLedger(new memory.MemoryLedgerStore(), { claimTtlMs: CLAIM_TTL });
    const claim = await ledger.claimSend('inst-a', 'idem-expire');
    assert.equal(claim.status, 'new');
    now += CLAIM_TTL + 1;
    const settled = await ledger.settleSend('inst-a', 'idem-expire', claim.claimToken, {
      messageId: 'm-1',
      threadId: 't',
      revision: 1,
    });
    assert.equal(settled, false, 'expired claim must return false through ledger');
  });

  test('settle boolean propagates through MessagingLedger.settleAppend', async () => {
    const ledger = new ledgerMod.MessagingLedger(new memory.MemoryLedgerStore(), { claimTtlMs: CLAIM_TTL });
    const claim = await ledger.claimAppend('inst-a', 'msg-1', 'op-expire');
    assert.equal(claim.status, 'new');
    now += CLAIM_TTL + 1;
    const settled = await ledger.settleAppend('inst-a', 'msg-1', 'op-expire', claim.claimToken, {
      messageId: 'msg-1',
      revision: 2,
      appliedElementIds: [],
    });
    assert.equal(settled, false, 'expired claim must return false through ledger');
  });
});
