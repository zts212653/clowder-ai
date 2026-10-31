import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildPersonMemoryDispositionLedgerEntry,
  buildSessionHandoffDispositionLedgerEntry,
  mintPersonMemoryDispositionOpaqueProof,
} from '../dist/domains/human-disposition/human-disposition-adapters.js';

const SESSION_PROPOSAL = {
  proposalId: 'handoff_proposal_1',
  sourceSessionId: 'session_source_1',
  sourceCatId: 'codex-terra',
  userId: 'owner-1',
};

const PERSON_PROOF = {
  opaqueLineageHandle: `f281_lineage_${'a'.repeat(43)}`,
  opaqueProposalHandle: `f281_proposal_${'b'.repeat(43)}`,
  opaqueSupersessionHandle: `f281_supersession_${'c'.repeat(43)}`,
  opaqueDecisionReceiptHandle: `f281_receipt_${'d'.repeat(43)}`,
};

const PERSON_CANONICAL_STATE = {
  ownerUserId: 'owner-1',
  requesterCatId: 'codex-sol',
};

describe('F281 canonical human-disposition adapters', () => {
  it('binds an F225 rejection to the exact canonical session-handoff source', () => {
    const entry = buildSessionHandoffDispositionLedgerEntry({
      proposal: SESSION_PROPOSAL,
      decidedAt: 1_755_000_001,
      feedback: { reasonCode: 'wrong_lane' },
    });

    assert.deepEqual(entry.episode, {
      interactionKind: 'session_handoff',
      subjectRef: 'session_source_1',
      proposalId: 'handoff_proposal_1',
      decision: 'rejected',
      producerCatId: 'codex-terra',
      ownerUserId: 'owner-1',
      decidedAt: 1_755_000_001,
      sourceRef: 'F225:session-handoff:handoff_proposal_1:reject',
      feedback: { reasonCode: 'wrong_lane' },
    });
    assert.deepEqual(entry.envelope?.scope, { kind: 'exact_subject' });
    assert.deepEqual(entry.envelope?.expiry, { kind: 'none' });
    assert.deepEqual(entry.envelope?.invalidator, { kind: 'none' });
  });

  it('accepts only typed, prefixed random-looking F276 opaque handles', () => {
    const canonical = {
      canonical: PERSON_CANONICAL_STATE,
      decidedAt: 1_755_000_002,
      feedback: { reasonCode: 'wrong' },
    };

    assert.doesNotThrow(() =>
      buildPersonMemoryDispositionLedgerEntry({
        ...canonical,
        proof: PERSON_PROOF,
      }),
    );
    assert.throws(
      () =>
        buildPersonMemoryDispositionLedgerEntry({
          ...canonical,
          proof: { ...PERSON_PROOF, opaqueLineageHandle: 'candidate_raw_1' },
        }),
      /opaqueLineageHandle/,
    );
    assert.throws(
      () =>
        buildPersonMemoryDispositionLedgerEntry({
          ...canonical,
          proof: { ...PERSON_PROOF, candidateId: 'candidate_raw_1' },
        }),
      /unrecognized key/i,
    );
  });

  it('never serializes raw F276 candidate, root, decision, person, or source identifiers', () => {
    const entry = buildPersonMemoryDispositionLedgerEntry({
      canonical: PERSON_CANONICAL_STATE,
      decidedAt: 1_755_000_003,
      feedback: { reasonCode: 'bad_evidence' },
      proof: PERSON_PROOF,
      candidateId: 'candidate_raw_1',
      rootProposalId: 'root_raw_1',
      decisionId: 'decision_raw_1',
      personId: 'person_raw_1',
      sourceRef: 'message_raw_1',
    });
    const serialized = JSON.stringify(entry);

    for (const rawIdentifier of ['candidate_raw_1', 'root_raw_1', 'decision_raw_1', 'person_raw_1', 'message_raw_1']) {
      assert.equal(serialized.includes(rawIdentifier), false, rawIdentifier);
    }
  });

  it('binds server identity from canonical state despite unrelated spoofed request fields', () => {
    const requestBody = {
      ownerUserId: 'attacker',
      producerCatId: 'attacker-cat',
      subjectRef: 'attacker-subject',
      sourceRef: 'attacker-source',
      decision: 'withdrawn',
    };
    const entry = buildSessionHandoffDispositionLedgerEntry({
      proposal: SESSION_PROPOSAL,
      decidedAt: 1_755_000_004,
      feedback: { reasonCode: 'not_important' },
      requestBody,
    });

    assert.equal(entry.episode.ownerUserId, 'owner-1');
    assert.equal(entry.episode.producerCatId, 'codex-terra');
    assert.equal(entry.episode.subjectRef, 'session_source_1');
    assert.equal(entry.episode.sourceRef, 'F225:session-handoff:handoff_proposal_1:reject');
    assert.equal(entry.episode.decision, 'rejected');
  });

  it('builds an episode-only record when feedback is absent', () => {
    const entry = buildSessionHandoffDispositionLedgerEntry({
      proposal: SESSION_PROPOSAL,
      decidedAt: 1_755_000_005,
    });

    assert.equal(entry.episode.feedback, undefined);
    assert.equal(entry.envelope, undefined);
  });

  it('builds an exact proposal-lineage envelope when F276 feedback is present', () => {
    const entry = buildPersonMemoryDispositionLedgerEntry({
      canonical: PERSON_CANONICAL_STATE,
      decidedAt: 1_755_000_006,
      feedback: { reasonCode: 'other', detail: '  证据主体不是这个人  ' },
      proof: PERSON_PROOF,
    });

    assert.deepEqual(entry.envelope, {
      interactionKind: 'person_memory_proposal',
      subjectRef: PERSON_PROOF.opaqueLineageHandle,
      proposalId: PERSON_PROOF.opaqueProposalHandle,
      decision: 'rejected',
      producerCatId: 'codex-sol',
      ownerUserId: 'owner-1',
      decidedAt: 1_755_000_006,
      scope: { kind: 'proposal_lineage', rootProposalId: PERSON_PROOF.opaqueLineageHandle },
      expiry: { kind: 'none' },
      invalidator: {
        kind: 'source_superseded',
        supersessionKey: PERSON_PROOF.opaqueSupersessionHandle,
      },
      sourceRef: PERSON_PROOF.opaqueDecisionReceiptHandle,
      feedback: { reasonCode: 'other', detail: '证据主体不是这个人' },
    });
  });

  it('rebuilds byte-stable F276 JSON from the same stored handles and decidedAt', () => {
    const input = {
      canonical: PERSON_CANONICAL_STATE,
      decidedAt: 1_755_000_007,
      feedback: { reasonCode: 'not_now' },
      proof: PERSON_PROOF,
    };

    assert.equal(
      JSON.stringify(buildPersonMemoryDispositionLedgerEntry(input)),
      JSON.stringify(buildPersonMemoryDispositionLedgerEntry(input)),
    );
  });

  it('mints independent opaque handles from server random bytes without producer input', () => {
    let fill = 1;
    const proof = mintPersonMemoryDispositionOpaqueProof((size) => {
      assert.equal(size, 32);
      return Buffer.alloc(size, fill++);
    });

    assert.match(proof.opaqueLineageHandle, /^f281_lineage_[A-Za-z0-9_-]{43}$/);
    assert.match(proof.opaqueProposalHandle, /^f281_proposal_[A-Za-z0-9_-]{43}$/);
    assert.match(proof.opaqueSupersessionHandle, /^f281_supersession_[A-Za-z0-9_-]{43}$/);
    assert.match(proof.opaqueDecisionReceiptHandle, /^f281_receipt_[A-Za-z0-9_-]{43}$/);
    assert.equal(new Set(Object.values(proof)).size, 4);
  });
});
