import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const { PRODUCTION_CONFIRMATION, assertSafeTarget, parseCliArgs, runBackfill } = await import(
  '../dist/scripts/f276-approval-history/backfill-settled-index.js'
);

function candidate(overrides = {}) {
  return {
    candidateId: 'person_candidate_wu_lang',
    ownerUserId: 'default-user',
    requesterCatId: 'codex-sol',
    sourceMessageRef: { kind: 'message', threadId: 'thread_people', messageId: 'msg_people' },
    claimDrafts: [],
    remainingDraftIds: [],
    retention: 'owner_controlled_no_ttl',
    createdAt: 100,
    state: 'materialized',
    materializedPersonId: 'person_wu_lang',
    latestDecisionReceipt: {
      decisionId: 'decision_wu_lang',
      candidateId: 'person_candidate_wu_lang',
      state: 'materialized',
      personId: 'person_wu_lang',
      selectedDraftIds: ['person_draft_wu_lang'],
      materializedClaimIds: ['person_claim_wu_lang'],
      materializedRelationshipIds: [],
      materializedEventIds: [],
      remainingDraftIds: [],
      decidedAt: 200,
    },
    publication: {
      state: 'anchored',
      envelope: {
        canonicalProposalId: 'person_candidate_wu_lang',
        sourceFeatureId: 'F276',
        ownerUserId: 'default-user',
        requesterCatId: 'codex-sol',
        originRef: { kind: 'message', threadId: 'thread_people', messageId: 'msg_people' },
        approvalCardRef: { threadId: 'thread_people', messageId: 'msg_card' },
        createdAt: 100,
      },
    },
    ...overrides,
  };
}

class FakeRedis {
  constructor(records) {
    this.records = new Map(Object.entries(records));
    this.sorted = new Map();
  }
  async scan() {
    return ['0', [...this.records.keys()].filter((key) => key.includes('person-memory:candidate:'))];
  }
  async get(key) {
    return this.records.get(key) ?? null;
  }
  async zscore(key, member) {
    return this.sorted.get(`${key}|${member}`) ?? null;
  }
  async zadd(key, score, member) {
    this.sorted.set(`${key}|${member}`, String(score));
    return 1;
  }
}

describe('F276 settled history backfill', () => {
  it('defaults to a zero-write preview target and guards runtime apply', () => {
    const defaults = parseCliArgs([], {});
    assert.deepEqual(defaults, { redisUrl: 'redis://127.0.0.1:6398', apply: false });
    assert.deepEqual(parseCliArgs(['--', '--dry-run', '--redis-url', 'redis://127.0.0.1:6398'], {}), defaults);
    assert.doesNotThrow(() => assertSafeTarget(defaults));
    assert.throws(() => assertSafeTarget({ redisUrl: 'redis://127.0.0.1:6399', apply: true }), /requires --confirm/);
    assert.doesNotThrow(() =>
      assertSafeTarget({
        redisUrl: 'redis://127.0.0.1:6399',
        apply: true,
        confirm: PRODUCTION_CONFIRMATION,
      }),
    );
  });

  it('adds terminal materialized and rejected candidates once, without indexing partial candidates', async () => {
    const records = {
      'cat-cafe:person-memory:candidate:default-user:person_candidate_wu_lang': JSON.stringify(candidate()),
      'cat-cafe:person-memory:candidate:default-user:person_candidate_rejected': JSON.stringify(
        candidate({
          candidateId: 'person_candidate_rejected',
          state: 'rejected',
          materializedPersonId: undefined,
          latestDecisionReceipt: undefined,
          humanDispositionLedgerEntry: {
            episode: {
              interactionKind: 'person_memory_proposal',
              subjectRef: 'f281_lineage_x',
              proposalId: 'f281_proposal_x',
              decision: 'rejected',
              producerCatId: 'codex-sol',
              ownerUserId: 'default-user',
              decidedAt: 300,
              sourceRef: 'f281_receipt_x',
            },
          },
        }),
      ),
      'cat-cafe:person-memory:candidate:default-user:person_candidate_partial': JSON.stringify(
        candidate({
          candidateId: 'person_candidate_partial',
          state: 'partially_materialized',
          latestDecisionReceipt: { ...candidate().latestDecisionReceipt, state: 'partially_materialized' },
        }),
      ),
    };
    const redis = new FakeRedis(records);

    const preview = await runBackfill(redis, false);
    assert.equal(preview.eligible, 2);
    assert.deepEqual(
      preview.missing.map(({ candidateId, decidedAt }) => ({ candidateId, decidedAt })),
      [
        { candidateId: 'person_candidate_wu_lang', decidedAt: 200 },
        { candidateId: 'person_candidate_rejected', decidedAt: 300 },
      ],
    );
    assert.equal(redis.sorted.size, 0);

    const applied = await runBackfill(redis, true);
    assert.equal(applied.applied, 2);
    const replay = await runBackfill(redis, true);
    assert.equal(replay.applied, 0);
    assert.equal(replay.alreadyIndexed, 2);
  });
});
