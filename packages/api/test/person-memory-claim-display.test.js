import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ownerMemoryActionEvidenceSchema, personClaimVersionSchema } from '@cat-cafe/shared';
import { PersonMemoryOwnerReadService } from '../dist/domains/memory/people/PersonMemoryOwnerReadService.js';
import { updatePersonMemoryCandidate } from '../dist/domains/memory/people/person-memory-candidate.js';
import { personAggregateOwnerRevision } from '../dist/domains/memory/people/person-memory-owner-revision.js';

const owner = 'owner-display';
const sourceRef = { kind: 'message', threadId: 'thread_display', messageId: 'message_display' };
const authority = {
  kind: 'card_approval',
  candidateId: 'person_candidate_display',
  draftId: 'person_draft_display',
  authorizedAt: 10,
};
const person = {
  personId: 'person_display',
  ownerUserId: owner,
  displayName: '展示样本',
  privateAliases: ['展示样本'],
  status: 'active',
  createdAt: 10,
  sourceRefs: [sourceRef],
  materializedBy: authority,
};
const baseClaim = personClaimVersionSchema.parse({
  claimId: 'person_claim_display',
  personId: person.personId,
  ownerUserId: owner,
  payload: { kind: 'reported_fact', predicate: 'birth_date', value: { year: 1999, month: 5 }, assertedBy: 'owner' },
  status: 'current',
  recordedAt: 10,
  sourceRefs: [sourceRef],
  materializedBy: authority,
});
const approvedSentence = '1999 年 5 月出生';
const baseCandidate = {
  candidateId: authority.candidateId,
  ownerUserId: owner,
  materializedPersonId: person.personId,
  state: 'partially_materialized',
  remainingDraftIds: ['person_draft_waiting'],
  claimDrafts: [
    { draftId: authority.draftId, payload: baseClaim.payload, normalizedDraft: approvedSentence, decision: 'approved' },
  ],
  approval: { approvedDraftIds: [authority.draftId], authorizedAt: 10 },
};

function fixture({
  claims = [structuredClone(baseClaim)],
  candidate = structuredClone(baseCandidate),
  failure = false,
} = {}) {
  const lookups = [];
  const service = new PersonMemoryOwnerReadService({
    store: {
      getPerson: async (user, id) => (user === owner && id === person.personId ? person : null),
      listPeople: async () => [person],
      listClaims: async () => claims,
      listRelationships: async () => [],
      listInteractionEvents: async () => [],
      listCandidateIdsForPerson: async () => [],
      getCandidateForOwner: async (user, id) => {
        lookups.push([user, id]);
        if (failure) throw new Error('candidate unavailable');
        return candidate;
      },
    },
    messageStore: { getById: async () => null },
    threadStore: { get: async () => null },
  });
  return { claims, lookups, read: () => service.readDetail(owner, person.personId), service };
}

test('owner detail returns the exact approved draft without altering canonical data or its revision', async () => {
  const f = fixture();
  const original = structuredClone(f.claims);
  const result = await f.read();
  assert.equal(result.status, 'ready');
  assert.equal(result.detail.claims[0].approvedText, approvedSentence);
  assert.deepEqual(f.lookups, [[owner, authority.candidateId]]);
  assert.deepEqual(f.claims, original);
  assert.equal(
    result.detail.personRevision,
    personAggregateOwnerRevision({ person, claims: original, relationships: [], events: [] }),
  );
  assert.equal((await f.service.readDetail('other-owner', person.personId)).status, 'not_available');
});

test('claims sharing an approval candidate fetch it once and resolve their own exact drafts', async () => {
  const second = {
    ...baseClaim,
    claimId: 'person_claim_second_display',
    materializedBy: { ...authority, draftId: 'person_draft_second_display' },
  };
  const candidate = {
    ...structuredClone(baseCandidate),
    approval: { ...baseCandidate.approval, approvedDraftIds: [authority.draftId, second.materializedBy.draftId] },
    claimDrafts: [
      ...structuredClone(baseCandidate.claimDrafts),
      {
        draftId: second.materializedBy.draftId,
        payload: second.payload,
        normalizedDraft: '另一条已批准原句',
        decision: 'approved',
      },
    ],
  };
  const f = fixture({ claims: [baseClaim, second], candidate });
  const result = await f.read();
  assert.deepEqual(
    result.detail.claims.map((c) => c.approvedText),
    [approvedSentence, '另一条已批准原句'],
  );
  assert.equal(f.lookups.length, 1);
});

test('unavailable or mismatched candidate evidence never replaces readable canonical content', async () => {
  const variants = [
    { candidate: null },
    { failure: true },
    { candidate: { ...baseCandidate, ownerUserId: 'other-owner' } },
    { candidate: { ...baseCandidate, candidateId: 'person_candidate_other' } },
    { candidate: { ...baseCandidate, materializedPersonId: 'person_elsewhere' } },
    {
      candidate: {
        ...baseCandidate,
        claimDrafts: [{ ...baseCandidate.claimDrafts[0], draftId: 'person_draft_other' }],
      },
    },
    { candidate: { ...baseCandidate, claimDrafts: [{ ...baseCandidate.claimDrafts[0], decision: 'pending' }] } },
    { candidate: { ...baseCandidate, approval: { ...baseCandidate.approval, approvedDraftIds: [] } } },
    {
      candidate: {
        ...baseCandidate,
        claimDrafts: [{ ...baseCandidate.claimDrafts[0], payload: { ...baseClaim.payload, value: '不同的内容' } }],
      },
    },
  ];
  for (const variant of variants) {
    const result = await fixture(variant).read();
    assert.equal(result.status, 'ready');
    assert.equal(result.detail.claims[0].approvedText, undefined);
    assert.deepEqual(result.detail.claims[0].payload, baseClaim.payload);
  }
});

test('fully settled candidates retain no draft text; owner detail still returns canonical content', async () => {
  const candidate = updatePersonMemoryCandidate(baseCandidate, new Set(['person_draft_waiting']), person.personId, 20);
  assert.equal(candidate.state, 'materialized');
  assert.deepEqual(candidate.claimDrafts, []);
  const result = await fixture({ candidate }).read();
  assert.equal(result.status, 'ready');
  assert.equal(result.detail.claims[0].approvedText, undefined);
  assert.deepEqual(result.detail.claims[0].payload, baseClaim.payload);
});

test('owner edits, explicit commands and corrections do not recover an older approval sentence', async () => {
  const digest = `sha256:${'a'.repeat(64)}`;
  const ownerAction = ownerMemoryActionEvidenceSchema.parse({
    kind: 'owner_memory_action',
    actionId: 'owner_action_display',
    action: 'correct_claim',
    ownerUserId: owner,
    sessionBindingDigest: digest,
    csrfVerificationDigest: digest,
    target: { personId: person.personId, itemKind: 'claim', itemId: baseClaim.claimId, expectedRevision: digest },
    requestId: 'request-display',
    requestDigest: digest,
    statementDigest: digest,
    sourceState: 'live',
    issuedAt: 20,
    evidenceDigest: digest,
  });
  const authorities = [
    ownerAction,
    { kind: 'explicit_memory_command', sourceMessageRef: sourceRef, boundedTarget: '这条判断', authorizedAt: 20 },
    { kind: 'anchored_correction', sourceMessageRef: sourceRef, existingTruthRef: baseClaim.claimId, authorizedAt: 20 },
  ];
  for (const materializedBy of authorities) {
    const updated = personClaimVersionSchema.parse({
      ...baseClaim,
      materializedBy,
      payload: { ...baseClaim.payload, predicate: '老家', value: '成都' },
      sourceRefs: materializedBy.kind === 'owner_memory_action' ? [] : [sourceRef],
    });
    const f = fixture({ claims: [updated] });
    const result = await f.read();
    assert.equal(result.detail.claims[0].approvedText, undefined);
    assert.deepEqual(f.lookups, []);
    assert.equal(result.detail.claims[0].payload.value, '成都');
  }
});

test('redacted records never recover approval text or inspect the retained candidate', async () => {
  const claim = personClaimVersionSchema.parse({
    ...baseClaim,
    status: 'redacted',
    payload: { kind: 'redacted' },
    sourceRefs: [],
  });
  const f = fixture({ claims: [claim] });
  const result = await f.read();
  assert.equal(result.detail.claims[0].approvedText, undefined);
  assert.deepEqual(f.lookups, []);
  assert(!JSON.stringify(result.detail).includes(approvedSentence));
});
