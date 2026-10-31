import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import Database from 'better-sqlite3';

function candidate(phrase, index) {
  return {
    phrase,
    normalizedPhrase: phrase.normalize('NFKC').toLowerCase(),
    window: {
      sinceInclusive: 1_000,
      untilInclusive: 2_000,
    },
    distinctThreadCount: 2,
    distinctMessageCount: 3,
    messageShare: 3 / 20,
    frequency: {
      background: {
        untilExclusive: 1_500,
        eligibleMessageCount: 10,
        distinctMessageCount: 1,
        messageShare: 1 / 10,
      },
      recentBurst: {
        sinceInclusive: 1_500,
        eligibleMessageCount: 10,
        distinctMessageCount: 2,
        messageShare: 2 / 10,
      },
    },
    sourceCoordinates: [
      { threadId: `thread-${index}-a`, messageIds: [`message-${index}-a`] },
      { threadId: `thread-${index}-b`, messageIds: [`message-${index}-b`, `message-${index}-c`] },
    ],
  };
}

describe('ProactiveCandidateNudgeReceiptStore', () => {
  it('persists only hashes and suppresses a delivered subject for one window', async () => {
    const { ProactiveCandidateNudgeReceiptStore } = await import(
      '../../dist/domains/memory/ProactiveCandidateNudgeReceiptStore.js'
    );
    const db = new Database(':memory:');
    try {
      const store = new ProactiveCandidateNudgeReceiptStore(db);
      const claimed = store.claim({
        ownerUserId: 'owner-secret',
        normalizedSubject: 'alden',
        now: 100,
        leaseMs: 50,
        windowEndsAt: 700,
      });
      assert.equal(claimed.outcome, 'claimed');
      assert.equal(
        store.claim({
          ownerUserId: 'owner-secret',
          normalizedSubject: 'alden',
          now: 120,
          leaseMs: 50,
          windowEndsAt: 700,
        }).outcome,
        'suppressed',
      );
      assert.equal(store.finalize({ claimId: claimed.receipt.claimId, deliveredAt: 130 }), true);
      assert.equal(
        store.claim({
          ownerUserId: 'owner-secret',
          normalizedSubject: 'alden',
          now: 140,
          leaseMs: 50,
          windowEndsAt: 700,
        }).outcome,
        'suppressed',
      );

      const raw = db.prepare('SELECT * FROM proactive_memory_nudge_receipts').get();
      assert.equal(JSON.stringify(raw).includes('owner-secret'), false);
      assert.equal(JSON.stringify(raw).includes('alden'), false);
      assert.equal(raw.state, 'delivered');
      assert.equal(raw.delivered_at, 130);

      const nextWindow = store.claim({
        ownerUserId: 'owner-secret',
        normalizedSubject: 'alden',
        now: 701,
        leaseMs: 50,
        windowEndsAt: 1_301,
      });
      assert.equal(nextWindow.outcome, 'claimed');
      assert.notEqual(nextWindow.receipt.claimId, claimed.receipt.claimId);
    } finally {
      db.close();
    }
  });

  it('recovers an expired construction lease and rejects a stale finalizer', async () => {
    const { ProactiveCandidateNudgeReceiptStore } = await import(
      '../../dist/domains/memory/ProactiveCandidateNudgeReceiptStore.js'
    );
    const db = new Database(':memory:');
    try {
      const store = new ProactiveCandidateNudgeReceiptStore(db);
      const first = store.claim({
        ownerUserId: 'owner-1',
        normalizedSubject: 'alden',
        now: 100,
        leaseMs: 50,
        windowEndsAt: 700,
      });
      assert.equal(first.outcome, 'claimed');
      assert.equal(
        store.claim({
          ownerUserId: 'owner-1',
          normalizedSubject: 'alden',
          now: 149,
          leaseMs: 50,
          windowEndsAt: 700,
        }).outcome,
        'suppressed',
      );

      const recovered = store.claim({
        ownerUserId: 'owner-1',
        normalizedSubject: 'alden',
        now: 151,
        leaseMs: 50,
        windowEndsAt: 700,
      });
      assert.equal(recovered.outcome, 'claimed');
      assert.notEqual(recovered.receipt.claimId, first.receipt.claimId);
      assert.equal(store.finalize({ claimId: first.receipt.claimId, deliveredAt: 160 }), false);
      assert.equal(store.finalize({ claimId: recovered.receipt.claimId, deliveredAt: 160 }), true);
    } finally {
      db.close();
    }
  });
});

describe('ProactiveMemoryNudgeService', () => {
  it('admits registered people/entities as known-person deltas while suppressing unresolved or pending subjects', async () => {
    const [{ ProactiveCandidateNudgeReceiptStore }, { ProactiveMemoryNudgeService }] = await Promise.all([
      import('../../dist/domains/memory/ProactiveCandidateNudgeReceiptStore.js'),
      import('../../dist/domains/memory/ProactiveMemoryNudgeService.js'),
    ]);
    const db = new Database(':memory:');
    try {
      const receiptStore = new ProactiveCandidateNudgeReceiptStore(db);
      const candidates = [
        'Registered Entity',
        'Registered Person',
        'Registered Non-Person',
        'Pending',
        'Unknown',
        'Alden',
        'Beryl',
      ].map(candidate);
      const registryCalls = [];
      const service = new ProactiveMemoryNudgeService({
        detector: {
          getConfig: () => ({ windowMs: 600, maxNudgesPerTurn: 3 }),
          detect: async (input) =>
            candidates.map((item) => ({
              ...item,
              window: {
                sinceInclusive: input.now - 1_000,
                untilInclusive: input.now,
              },
            })),
        },
        registryResolver: {
          resolve: async ({ phrase }) => {
            registryCalls.push(phrase);
            if (phrase === 'Registered Entity') return { kind: 'registered_entity', ref: 'entity:registered' };
            if (phrase === 'Registered Person') return { kind: 'registered_person', ref: 'person:registered' };
            if (phrase === 'Registered Non-Person') {
              return { kind: 'registered_non_person_entity', ref: 'feature:registered' };
            }
            if (phrase === 'Pending') {
              return { kind: 'pending_candidate', producerId: 'F276', proposalId: 'person_candidate_pending' };
            }
            if (phrase === 'Unknown') return { kind: 'unknown' };
            return { kind: 'unregistered' };
          },
        },
        receiptStore,
        claimLeaseMs: 50,
      });

      const prepared = await service.prepare({
        ownerUserId: 'owner-1',
        currentUserMessageId: 'message-current',
        now: 2_000,
      });
      assert.deepEqual(
        prepared.candidates.map((item) => item.phrase),
        ['Registered Entity', 'Registered Person', 'Alden'],
      );
      assert.equal(registryCalls.includes('Registered Entity'), true);
      assert.equal(registryCalls.includes('Registered Person'), true);
      assert.equal(registryCalls.includes('Registered Non-Person'), true);
      assert.equal(registryCalls.includes('Pending'), true);
      assert.equal(registryCalls.includes('Unknown'), true);
      assert.equal(registryCalls.includes('Beryl'), true, 'registry filtering must complete before cap');
      assert.equal(db.prepare('SELECT COUNT(*) AS count FROM proactive_memory_nudge_receipts').get().count, 3);
      assert.equal(prepared.context.includes('[proactive-memory-candidate]'), true);
      assert.equal(prepared.context.includes('[registration-candidate]'), false);
      assert.equal(prepared.context.includes('propose_'), false);
      assert.equal(prepared.context.includes('应该记录'), false);
      assert.equal(prepared.context.includes('2 threads / 3 messages'), true);
      assert.equal(prepared.context.includes('background 1/10 messages; recent 2/10 messages'), true);
      assert.equal(prepared.context.includes('known-person delta'), true);
      assert.equal(prepared.context.includes('registered_entity'), true);
      assert.equal(prepared.context.includes('registered_person'), true);
      assert.equal(prepared.context.includes('thread-0-a'), true);
      assert.equal(
        receiptStore.read({
          ownerUserId: 'owner-1',
          normalizedSubject: 'beryl',
        }),
        null,
      );

      assert.equal(service.finalize(prepared, 2_010), 3);
      const retry = await service.prepare({
        ownerUserId: 'owner-1',
        currentUserMessageId: 'message-current',
        now: 2_000,
      });
      assert.deepEqual(retry.candidates, []);
      assert.equal(retry.context, '');

      const nextMessage = await service.prepare({
        ownerUserId: 'owner-1',
        currentUserMessageId: 'message-next',
        now: 2_020,
      });
      assert.deepEqual(
        nextMessage.candidates.map((item) => item.phrase),
        ['Beryl'],
      );
      assert.equal(nextMessage.context.includes('Beryl'), true);
    } finally {
      db.close();
    }
  });
});
