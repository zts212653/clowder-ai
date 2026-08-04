/**
 * K-1 / F288 — Service-level stale-claimant settlement + scope defensiveness
 *
 * Settlement: SendService.send() (222-233) and AppendService.appendElements()
 * (82-95) must return canonical receipts when a stale claimant's settle is
 * superseded. Uses InterceptingLedgerStore to deterministically hook
 * settle()/claim() without mocking the real services.
 *
 * Scope: MemoryHandleStore must snapshot scope on write (INV-22 parity).
 */
import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';

/** @type {typeof import('../dist/domains/messaging/stores/memory.js')} */
let memory;
/** @type {typeof import('../dist/domains/messaging/handles.js')} */
let handlesMod;
/** @type {typeof import('../dist/domains/messaging/ledger.js')} */
let ledgerMod;
/** @type {typeof import('../dist/domains/messaging/send-service.js')} */
let sendMod;
/** @type {typeof import('../dist/domains/messaging/append-service.js')} */
let appendMod;
let MessageStore;

let messageStore;
let handles;
let events;

const CTX = { pluginInstanceId: 'inst-a' };

beforeEach(async () => {
  memory = await import('../dist/domains/messaging/stores/memory.js');
  handlesMod = await import('../dist/domains/messaging/handles.js');
  ledgerMod = await import('../dist/domains/messaging/ledger.js');
  sendMod = await import('../dist/domains/messaging/send-service.js');
  appendMod = await import('../dist/domains/messaging/append-service.js');
  ({ MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js'));

  messageStore = new MessageStore();
  handles = new handlesMod.HandleService(new memory.MemoryHandleStore(), new memory.MemoryCursorStore());
  events = new memory.MemoryEventLogStore();
});

// ── Helpers ──

async function issueHandle() {
  const { handleId } = await handles.issueThreadHandle({
    pluginInstanceId: 'inst-a',
    threadId: 'thread-1',
    userId: 'user-1',
    scope: { canSend: true, canSubscribe: true },
  });
  return handleId;
}

function draftFor(handleId, overrides = {}) {
  return {
    address: { kind: 'thread_handle', handle: handleId },
    idempotencyKey: `idem-${Date.now()}`,
    payload: {
      provenance: { epistemicStatus: 'inference' },
      elements: [{ elementId: 'el-1', kind: 'text', payload: { text: 'hello' } }],
    },
    ...overrides,
  };
}

// ── Intercepting ledger store ──

/**
 * Wraps MemoryLedgerStore; hooks fire once before the target operation to
 * simulate claim expiry + canonical settlement by a concurrent caller ("B").
 *
 * preSettle: fires before the FIRST settle() call.
 * preReClaim: fires before the SECOND claim() call for the SAME key
 * (the rejected-path re-claim in the service).
 */
class InterceptingLedgerStore {
  constructor(/** @type {InstanceType<typeof memory.MemoryLedgerStore>} */ inner) {
    this.inner = inner;
    /** @type {((store: any, key: string) => Promise<void>) | null} */
    this.preSettle = null;
    /** @type {((store: any, key: string) => Promise<void>) | null} */
    this.preReClaim = null;
    /** @type {Map<string, number>} */
    this._claimCounts = new Map();
  }

  async claim(/** @type {string} */ key, /** @type {number} */ ttl) {
    const count = (this._claimCounts.get(key) || 0) + 1;
    this._claimCounts.set(key, count);
    if (this.preReClaim && count > 1) {
      const hook = this.preReClaim;
      this.preReClaim = null;
      await hook(this.inner, key);
    }
    return this.inner.claim(key, ttl);
  }

  async settle(
    /** @type {string} */ key,
    /** @type {string} */ claimToken,
    /** @type {unknown} */ receipt,
    /** @type {number} */ retentionMs,
  ) {
    if (this.preSettle) {
      const hook = this.preSettle;
      this.preSettle = null;
      await hook(this.inner, key);
    }
    return this.inner.settle(key, claimToken, receipt, retentionMs);
  }

  release(/** @type {string} */ key, /** @type {string} */ claimToken) {
    return this.inner.release(key, claimToken);
  }
}

// Canonical receipts with DISTINCT values — the test verifies the service
// returns these (from the ledger), not its locally constructed receipt.
const CANONICAL_SEND = {
  messageId: 'B-msg-id',
  threadId: 'B-thread',
  revision: 1,
  handle: { kind: 'message', token: 'B-handle-token' },
};

const CANONICAL_APPEND = {
  messageId: 'B-append-msg',
  revision: 99,
  appliedElementIds: ['B-el-1'],
};

/**
 * Pre-settle hook: expire A's claim, then B claims + settles canonical.
 * After this hook, A's settle() sees status='settled' → already_settled.
 */
function alreadySettledHook(canonical) {
  return async (store, key) => {
    const entry = store.entries.get(key);
    if (entry) store.entries.set(key, { ...entry, expiresAt: 0 });
    const b = await store.claim(key, 60_000);
    await store.settle(key, b.claimToken, canonical, 7 * 86_400_000);
  };
}

/**
 * Pre-settle hook: expire A's claim, then B claims but does NOT settle.
 * After this hook, A's settle() sees status='inflight' + wrong claimToken
 * → rejected.
 */
function rejectedHook() {
  return async (store, key) => {
    const entry = store.entries.get(key);
    if (entry) store.entries.set(key, { ...entry, expiresAt: 0 });
    await store.claim(key, 60_000); // B claims, still inflight
  };
}

/**
 * Pre-re-claim hook: B settles canonical before A's re-claim.
 * A's re-claim sees status='settled' → returns canonical receipt.
 */
function reClaimSettledHook(canonical) {
  return async (store, key) => {
    const entry = store.entries.get(key);
    if (entry && entry.status === 'inflight') {
      await store.settle(key, entry.claimToken, canonical, 7 * 86_400_000);
    }
  };
}

// ── SendService settlement tests ──

describe('SendService — stale-claimant settlement (lines 222-233)', () => {
  test('already_settled → returns canonical receipt, not local', async () => {
    const raw = new memory.MemoryLedgerStore();
    const intercepting = new InterceptingLedgerStore(raw);
    intercepting.preSettle = alreadySettledHook(CANONICAL_SEND);
    const ledger = new ledgerMod.MessagingLedger(intercepting);
    const service = new sendMod.SendService({
      messageStore,
      handles,
      ledger,
      events,
      isKnownCatId: () => true,
    });

    const handleId = await issueHandle();
    const result = await service.send(CTX, draftFor(handleId));

    // Must return B's canonical receipt, NOT A's locally constructed value
    assert.equal(result.messageId, CANONICAL_SEND.messageId);
    assert.equal(result.threadId, CANONICAL_SEND.threadId);
    assert.deepEqual(result.handle, CANONICAL_SEND.handle);
  });

  test('rejected → re-claim settled → returns canonical receipt', async () => {
    const raw = new memory.MemoryLedgerStore();
    const intercepting = new InterceptingLedgerStore(raw);
    intercepting.preSettle = rejectedHook();
    intercepting.preReClaim = reClaimSettledHook(CANONICAL_SEND);
    const ledger = new ledgerMod.MessagingLedger(intercepting);
    const service = new sendMod.SendService({
      messageStore,
      handles,
      ledger,
      events,
      isKnownCatId: () => true,
    });

    const handleId = await issueHandle();
    const result = await service.send(CTX, draftFor(handleId));

    assert.equal(result.messageId, CANONICAL_SEND.messageId);
    assert.deepEqual(result.handle, CANONICAL_SEND.handle);
  });

  test('rejected → re-claim inflight → throws RETRYABLE_INFLIGHT', async () => {
    const raw = new memory.MemoryLedgerStore();
    const intercepting = new InterceptingLedgerStore(raw);
    intercepting.preSettle = rejectedHook();
    // No preReClaim — B is still inflight → re-claim returns inflight
    const ledger = new ledgerMod.MessagingLedger(intercepting);
    const service = new sendMod.SendService({
      messageStore,
      handles,
      ledger,
      events,
      isKnownCatId: () => true,
    });

    const handleId = await issueHandle();
    await assert.rejects(service.send(CTX, draftFor(handleId)), (err) => {
      assert.equal(err.name, 'MessagingError');
      assert.equal(err.code, 'RETRYABLE_INFLIGHT');
      return true;
    });
  });
});

// ── AppendService settlement tests ──

describe('AppendService — stale-claimant settlement (lines 82-95)', () => {
  /** Send a message first (normal ledger path), then return receipt + service. */
  async function setupAppend(intercepting) {
    const ledger = new ledgerMod.MessagingLedger(intercepting);
    const appendLock = new memory.MemoryAppendLock();
    const sendService = new sendMod.SendService({
      messageStore,
      handles,
      ledger,
      events,
      isKnownCatId: () => true,
    });
    const appendService = new appendMod.AppendService({
      messageStore,
      handles,
      ledger,
      events,
      appendLock,
    });

    // Send a message normally (preSettle is null → no interception yet)
    const handleId = await issueHandle();
    const sendReceipt = await sendService.send(CTX, draftFor(handleId));
    return { appendService, sendReceipt };
  }

  test('already_settled → returns canonical receipt, not local', async () => {
    const raw = new memory.MemoryLedgerStore();
    const intercepting = new InterceptingLedgerStore(raw);
    const { appendService, sendReceipt } = await setupAppend(intercepting);

    // Arm interception for the APPEND settlement
    intercepting.preSettle = alreadySettledHook(CANONICAL_APPEND);

    const result = await appendService.appendElements(CTX, {
      handle: sendReceipt.handle,
      operationId: 'op-stale',
      elements: [{ elementId: 'el-a', kind: 'text', payload: { text: 'appended' } }],
    });

    assert.equal(result.messageId, CANONICAL_APPEND.messageId);
    assert.equal(result.revision, CANONICAL_APPEND.revision);
    assert.deepEqual(result.appliedElementIds, CANONICAL_APPEND.appliedElementIds);
  });

  test('rejected → re-claim settled → returns canonical receipt', async () => {
    const raw = new memory.MemoryLedgerStore();
    const intercepting = new InterceptingLedgerStore(raw);
    const { appendService, sendReceipt } = await setupAppend(intercepting);

    intercepting.preSettle = rejectedHook();
    intercepting.preReClaim = reClaimSettledHook(CANONICAL_APPEND);

    const result = await appendService.appendElements(CTX, {
      handle: sendReceipt.handle,
      operationId: 'op-stale-rej',
      elements: [{ elementId: 'el-b', kind: 'text', payload: { text: 'appended' } }],
    });

    assert.equal(result.messageId, CANONICAL_APPEND.messageId);
  });

  test('rejected → re-claim inflight → throws RETRYABLE_INFLIGHT', async () => {
    const raw = new memory.MemoryLedgerStore();
    const intercepting = new InterceptingLedgerStore(raw);
    const { appendService, sendReceipt } = await setupAppend(intercepting);

    intercepting.preSettle = rejectedHook();

    await assert.rejects(
      appendService.appendElements(CTX, {
        handle: sendReceipt.handle,
        operationId: 'op-stale-inf',
        elements: [{ elementId: 'el-c', kind: 'text', payload: { text: 'appended' } }],
      }),
      (err) => {
        assert.equal(err.name, 'MessagingError');
        assert.equal(err.code, 'RETRYABLE_INFLIGHT');
        return true;
      },
    );
  });
});
