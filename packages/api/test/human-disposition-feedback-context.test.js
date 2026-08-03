import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildHumanDispositionLedgerEntry } from '@cat-cafe/shared';
import { HumanDispositionFeedbackContextService } from '../dist/domains/human-disposition/HumanDispositionFeedbackContextService.js';
import { PersonMemoryDispositionSubjectProofResolver } from '../dist/domains/memory/people/PersonMemoryDispositionSubjectProofResolver.js';

function entry({ subjectRef, sourceRef, supersessionKey, decidedAt, feedback = { reasonCode: 'bad_evidence' } }) {
  return buildHumanDispositionLedgerEntry(feedback === null ? undefined : feedback, {
    interactionKind: 'person_memory_proposal',
    subjectRef,
    proposalId: `proposal_${sourceRef}`,
    decision: 'rejected',
    producerCatId: 'codex-sol',
    ownerUserId: 'owner-a',
    decidedAt,
    scope: { kind: 'proposal_lineage', rootProposalId: subjectRef },
    expiry: { kind: 'none' },
    invalidator: { kind: 'source_superseded', supersessionKey },
    sourceRef,
  });
}

function fakeService({ proofs = new Map(), entries = new Map(), queryError = false } = {}) {
  const calls = [];
  const service = new HumanDispositionFeedbackContextService({
    subjectResolver: {
      async resolve(input) {
        calls.push(input);
        return proofs.get(input.phrase) ?? { status: 'unknown' };
      },
    },
    ledger: {
      async query(ownerUserId, options) {
        if (queryError) throw new Error('ledger unavailable');
        return {
          entries: entries.get(`${ownerUserId}:${options.subjectRef}`) ?? [],
          scannedCount: 0,
        };
      },
    },
  });
  return { service, calls };
}

const ZHOU_PROOF = {
  status: 'verified',
  subjectRef: 'f281_lineage_zhou',
  currentSupersessionKey: 'f281_supersession_current',
};

describe('F281 HumanDispositionFeedbackContextService', () => {
  it('renders the newest eligible correction for an exact dormant F276 subject', async () => {
    const current = entry({
      subjectRef: ZHOU_PROOF.subjectRef,
      sourceRef: 'f281_receipt_current',
      supersessionKey: ZHOU_PROOF.currentSupersessionKey,
      decidedAt: 200,
    });
    const { service } = fakeService({
      proofs: new Map([['周玉晶', ZHOU_PROOF]]),
      entries: new Map([[`owner-a:${ZHOU_PROOF.subjectRef}`, [current]]]),
    });

    const context = await service.prepare({ ownerUserId: 'owner-a', text: '周玉晶', now: 300 });
    assert.match(context, /\[human-disposition-feedback\]/);
    assert.match(context, /reason=bad_evidence correction=repair_exact_subject_evidence/);
    for (const forbidden of [
      ZHOU_PROOF.subjectRef,
      ZHOU_PROOF.currentSupersessionKey,
      'f281_receipt_current',
      'score',
      '评分',
      'acceptance',
      'lane policy',
    ]) {
      assert.equal(context.includes(forbidden), false, forbidden);
    }
  });

  it('uses one verified root across a replacement and rejects handle-only or broken proof', async () => {
    const current = entry({
      subjectRef: ZHOU_PROOF.subjectRef,
      sourceRef: 'f281_receipt_replacement',
      supersessionKey: ZHOU_PROOF.currentSupersessionKey,
      decidedAt: 200,
    });
    const visible = fakeService({
      proofs: new Map([['周玉晶', ZHOU_PROOF]]),
      entries: new Map([[`owner-a:${ZHOU_PROOF.subjectRef}`, [current]]]),
    });
    assert.notEqual(await visible.service.prepare({ ownerUserId: 'owner-a', text: '周玉晶', now: 300 }), '');

    for (const failure of ['locator_collision', 'binding_mismatch', 'mixed_person', 'missing_membership']) {
      const hidden = fakeService({
        proofs: new Map([['周玉晶', { status: 'unknown', failure }]]),
        entries: new Map([[`owner-a:${ZHOU_PROOF.subjectRef}`, [current]]]),
      });
      assert.equal(await hidden.service.prepare({ ownerUserId: 'owner-a', text: '周玉晶', now: 300 }), '', failure);
    }
  });

  it('does not generalize to another subject, owner, ambiguous registry result, or failed hydration', async () => {
    const current = entry({
      subjectRef: ZHOU_PROOF.subjectRef,
      sourceRef: 'f281_receipt_scope',
      supersessionKey: ZHOU_PROOF.currentSupersessionKey,
      decidedAt: 200,
    });
    const exactOnly = fakeService({
      proofs: new Map([['周玉晶', ZHOU_PROOF]]),
      entries: new Map([[`owner-a:${ZHOU_PROOF.subjectRef}`, [current]]]),
    });
    assert.equal(await exactOnly.service.prepare({ ownerUserId: 'owner-a', text: 'Alden', now: 300 }), '');
    assert.equal(await exactOnly.service.prepare({ ownerUserId: 'owner-b', text: '周玉晶', now: 300 }), '');

    const unavailable = fakeService({
      proofs: new Map([['周玉晶', ZHOU_PROOF]]),
      queryError: true,
    });
    assert.equal(await unavailable.service.prepare({ ownerUserId: 'owner-a', text: '周玉晶', now: 300 }), '');
  });

  it('selects only the newest envelope and lets newer other supersede older automatic feedback', async () => {
    const older = entry({
      subjectRef: ZHOU_PROOF.subjectRef,
      sourceRef: 'f281_receipt_older',
      supersessionKey: 'f281_supersession_older',
      decidedAt: 100,
      feedback: { reasonCode: 'wrong' },
    });
    const newest = entry({
      subjectRef: ZHOU_PROOF.subjectRef,
      sourceRef: 'f281_receipt_newest',
      supersessionKey: ZHOU_PROOF.currentSupersessionKey,
      decidedAt: 200,
      feedback: { reasonCode: 'not_important' },
    });
    const auto = fakeService({
      proofs: new Map([['周玉晶', ZHOU_PROOF]]),
      entries: new Map([[`owner-a:${ZHOU_PROOF.subjectRef}`, [newest, older]]]),
    });
    const context = await auto.service.prepare({ ownerUserId: 'owner-a', text: '周玉晶', now: 300 });
    assert.match(context, /reason=not_important correction=dormant_exact_subject/);
    assert.equal(context.includes('correct_exact_subject'), false);

    const other = entry({
      subjectRef: ZHOU_PROOF.subjectRef,
      sourceRef: 'f281_receipt_other',
      supersessionKey: ZHOU_PROOF.currentSupersessionKey,
      decidedAt: 300,
      feedback: { reasonCode: 'other', detail: 'private free-form detail' },
    });
    const humanOnly = fakeService({
      proofs: new Map([['周玉晶', ZHOU_PROOF]]),
      entries: new Map([[`owner-a:${ZHOU_PROOF.subjectRef}`, [other, older]]]),
    });
    assert.equal(await humanOnly.service.prepare({ ownerUserId: 'owner-a', text: '周玉晶', now: 400 }), '');
  });

  it('ignores an episode-only root and a mismatched current supersession proof', async () => {
    const decisionOnly = entry({
      subjectRef: ZHOU_PROOF.subjectRef,
      sourceRef: 'f281_receipt_no_feedback',
      supersessionKey: ZHOU_PROOF.currentSupersessionKey,
      decidedAt: 200,
      feedback: null,
    });
    const noFeedback = fakeService({
      proofs: new Map([['周玉晶', ZHOU_PROOF]]),
      entries: new Map([[`owner-a:${ZHOU_PROOF.subjectRef}`, [decisionOnly]]]),
    });
    assert.equal(await noFeedback.service.prepare({ ownerUserId: 'owner-a', text: '周玉晶', now: 300 }), '');

    const stale = entry({
      subjectRef: ZHOU_PROOF.subjectRef,
      sourceRef: 'f281_receipt_stale',
      supersessionKey: 'f281_supersession_stale',
      decidedAt: 200,
    });
    const mismatched = fakeService({
      proofs: new Map([['周玉晶', ZHOU_PROOF]]),
      entries: new Map([[`owner-a:${ZHOU_PROOF.subjectRef}`, [stale]]]),
    });
    assert.equal(await mismatched.service.prepare({ ownerUserId: 'owner-a', text: '周玉晶', now: 300 }), '');
  });

  it('emits at most one correction per root and at most three roots', async () => {
    const names = ['周玉晶', '李小明', '王小红', '陈小蓝'];
    const proofs = new Map();
    const entries = new Map();
    for (const [index, name] of names.entries()) {
      const proof = {
        status: 'verified',
        subjectRef: `f281_lineage_${index}`,
        currentSupersessionKey: `f281_supersession_${index}`,
      };
      proofs.set(name, proof);
      entries.set(`owner-a:${proof.subjectRef}`, [
        entry({
          subjectRef: proof.subjectRef,
          sourceRef: `f281_receipt_${index}`,
          supersessionKey: proof.currentSupersessionKey,
          decidedAt: 200 + index,
        }),
      ]);
    }
    const { service } = fakeService({ proofs, entries });
    const context = await service.prepare({ ownerUserId: 'owner-a', text: names.join(' '), now: 500 });
    assert.equal(context.match(/scope=exact_subject/g)?.length, 3);
  });
});

describe('F276 PersonMemoryDispositionSubjectProofResolver', () => {
  it('returns only an opaque proof for the exact current F276 binding', async () => {
    const candidate = {
      candidateId: 'person_candidate_private',
      dispositionLineageBindingKey: 'person-memory:private-binding',
    };
    const resolver = new PersonMemoryDispositionSubjectProofResolver(
      {
        resolve: async () => ({
          kind: 'dormant_candidate',
          producerId: 'F276',
          proposalId: candidate.candidateId,
        }),
      },
      { getCandidateForOwner: async () => candidate },
      {
        resolveClosure: async () => ({
          status: 'eligible',
          ownerUserId: 'owner-a',
          closurePersonId: 'person_private',
          root: candidate,
          current: candidate,
          chain: [candidate],
          bindingKey: candidate.dispositionLineageBindingKey,
        }),
        loadBinding: async () => ({
          version: 1,
          ownerUserId: 'owner-a',
          closurePersonId: 'person_private',
          rootCandidateId: candidate.candidateId,
          currentCandidateId: candidate.candidateId,
          opaqueLineageHandle: ZHOU_PROOF.subjectRef,
          currentOpaqueProposalHandle: 'f281_proposal_private',
          currentOpaqueSupersessionHandle: ZHOU_PROOF.currentSupersessionKey,
        }),
      },
    );
    assert.deepEqual(await resolver.resolve({ ownerUserId: 'owner-a', phrase: '周玉晶' }), ZHOU_PROOF);
  });

  it('fails closed before exposing proof for non-F276 or cross-wired registry/binding truth', async () => {
    const cases = [
      {
        registry: { kind: 'unknown' },
        candidate: null,
      },
      {
        registry: { kind: 'dormant_candidate', producerId: 'F260', proposalId: 'foreign' },
        candidate: null,
      },
      {
        registry: { kind: 'dormant_candidate', producerId: 'F276', proposalId: 'missing' },
        candidate: null,
      },
      {
        registry: { kind: 'dormant_candidate', producerId: 'F276', proposalId: 'candidate' },
        candidate: { candidateId: 'candidate', dispositionLineageBindingKey: 'binding-a' },
        bindingCandidateId: 'other',
      },
    ];
    for (const current of cases) {
      const resolver = new PersonMemoryDispositionSubjectProofResolver(
        { resolve: async () => current.registry },
        { getCandidateForOwner: async () => current.candidate },
        {
          resolveClosure: async (_owner, candidate) => ({
            status: 'eligible',
            ownerUserId: 'owner-a',
            closurePersonId: 'person_private',
            root: candidate,
            current: candidate,
            chain: [candidate],
            bindingKey: 'binding-a',
          }),
          loadBinding: async () => ({
            version: 1,
            ownerUserId: 'owner-a',
            closurePersonId: 'person_private',
            rootCandidateId: 'candidate',
            currentCandidateId: current.bindingCandidateId ?? 'candidate',
            opaqueLineageHandle: ZHOU_PROOF.subjectRef,
            currentOpaqueProposalHandle: 'f281_proposal_private',
            currentOpaqueSupersessionHandle: ZHOU_PROOF.currentSupersessionKey,
          }),
        },
      );
      assert.deepEqual(await resolver.resolve({ ownerUserId: 'owner-a', phrase: '周玉晶' }), {
        status: 'unknown',
      });
    }
  });
});
