import {
  buildF287AlphaOwnerFixture,
  F287_PERSON_MEMORY_FIXTURE_REVISION,
  type F287AlphaOwnerFixture,
  type F287JsonRecord,
  type F287PersonMemoryLifecycleUatInput,
  type F287PersonMemoryLifecycleUatResult,
  f287CallbackRequest,
  f287OwnerRequest,
  optionalF287StringArray,
  requireF287AlphaOrigin,
  requireF287Record,
  requireF287String,
  requireF287StringArray,
  validateF287RunId,
} from './f287-person-memory-lifecycle-uat-contract.js';

async function resolveOwnerSourceMessageId(
  input: F287PersonMemoryLifecycleUatInput,
  origin: string,
  fixture: F287AlphaOwnerFixture,
): Promise<string> {
  const context = await f287CallbackRequest(
    input,
    origin,
    'source lookup',
    '/api/callbacks/thread-context?responseMode=full&limit=20',
    'GET',
  );
  if (!Array.isArray(context.messages)) throw new Error('source lookup response is missing messages');
  const source = [...context.messages]
    .reverse()
    .map((message) => requireF287Record(message, 'source lookup'))
    .find((message) => typeof message.content === 'string' && message.content.includes(fixture.marker));
  if (!source) throw new Error('source lookup did not find the alpha-only owner fixture marker');
  return requireF287String(source, 'id', 'source lookup');
}

export function buildF287PersonMemoryProposalBody(
  fixture: F287AlphaOwnerFixture,
  sourceMessageId: string,
  runId: string,
): F287JsonRecord {
  const sourceId = 'f287-alpha-owner-source';
  return {
    person: { displayName: fixture.displayName, privateAliases: [fixture.displayName] },
    claims: [
      {
        payload: {
          kind: 'reported_fact',
          predicate: 'project_role',
          value: fixture.initialFactValue,
          assertedBy: 'owner',
        },
        normalizedDraft: `${fixture.displayName} role ${fixture.initialFactValue}`,
        sourceRole: 'owner_explicit',
        evidenceExcerpt: `${fixture.displayName} role ${fixture.initialFactValue}`,
      },
    ],
    relationship: {
      payload: { status: 'current' },
      normalizedDraft: fixture.relationshipEvidence,
      sourceRole: 'owner_explicit',
      evidenceExcerpt: fixture.relationshipEvidence,
    },
    interaction: {
      payload: {
        eventKind: 'meeting',
        headline: fixture.interactionHeadline,
        importanceOrTopic: 'uat',
        uncertaintyNotes: [],
      },
      normalizedDraft: fixture.interactionEvidence,
      sourceRole: 'owner_explicit',
      evidenceExcerpt: fixture.interactionEvidence,
    },
    sourceBundle: {
      sources: [
        {
          sourceId,
          kind: 'message_text',
          messageId: sourceMessageId,
          excerpt: fixture.proposalEvidenceText,
        },
      ],
      assertionBindings: [
        {
          sourceId,
          target: { kind: 'claim', index: 0 },
          role: 'reported_fact',
        },
        {
          sourceId,
          target: { kind: 'relationship', field: 'status' },
          role: 'reported_fact',
        },
        {
          sourceId,
          target: { kind: 'interaction', field: 'eventKind' },
          role: 'reported_fact',
        },
        {
          sourceId,
          target: { kind: 'interaction', field: 'headline' },
          role: 'reported_fact',
        },
        {
          sourceId,
          target: { kind: 'interaction', field: 'importanceOrTopic' },
          role: 'user_assessment',
        },
      ],
    },
    sourceMessageId,
    clientRequestId: `f287-alpha-lifecycle-${runId}`,
  };
}

function resolvedCard(response: F287JsonRecord, step: string): F287JsonRecord {
  if (requireF287String(response, 'status', step) !== 'resolved') {
    throw new Error(`${step} did not resolve the alpha-only person`);
  }
  return requireF287Record(response.card, step);
}

function cardFacts(card: F287JsonRecord, step: string): F287JsonRecord[] {
  if (!Array.isArray(card.facts)) throw new Error(`${step} response is missing facts`);
  return card.facts.map((fact) => requireF287Record(fact, step));
}

function factText(fact: F287JsonRecord, step: string): string {
  return requireF287String(fact, 'text', step);
}

interface PreparedLifecycle {
  readonly proposalId: string;
  readonly proposalStatus: string;
  readonly approvalStatus: string;
  readonly personId: string;
  readonly selectedDraftIds: string[];
  readonly materializedClaimIds: string[];
  readonly materializedRelationshipIds: string[];
  readonly materializedEventIds: string[];
}

async function prepareLifecycle(
  input: F287PersonMemoryLifecycleUatInput,
  origin: string,
  runId: string,
  fixture: F287AlphaOwnerFixture,
): Promise<PreparedLifecycle> {
  const sourceMessageId = await resolveOwnerSourceMessageId(input, origin, fixture);
  const proposal = await f287CallbackRequest(
    input,
    origin,
    'propose',
    '/api/callbacks/propose-person-memory',
    'POST',
    buildF287PersonMemoryProposalBody(fixture, sourceMessageId, runId),
  );
  const proposalId = requireF287String(proposal, 'candidateId', 'propose');
  const proposalStatus = requireF287String(proposal, 'status', 'propose');
  const status = await f287CallbackRequest(
    input,
    origin,
    'proposal status',
    `/api/callbacks/person-memory/proposals/${encodeURIComponent(proposalId)}/status`,
    'GET',
  );
  if (requireF287String(status, 'publicationState', 'proposal status') !== 'anchored') {
    throw new Error('proposal status is not anchored');
  }
  const selectedDraftIds = requireF287StringArray(status, 'remainingDraftIds', 'proposal status');
  if (selectedDraftIds.length !== 3) throw new Error('proposal status must expose exactly three informed drafts');
  const approval = await f287OwnerRequest(
    input,
    origin,
    'approve',
    `/api/person-memory-proposals/${encodeURIComponent(proposalId)}/approve`,
    { selectedDraftIds, decisionId: `f287-alpha-approve-${runId}` },
  );
  const approvalStatus = requireF287String(approval, 'status', 'approve');
  if (approvalStatus !== 'materialized') throw new Error('approve did not materialize the alpha-only person');
  const materializedClaimIds = requireF287StringArray(approval, 'materializedClaimIds', 'approve');
  const materializedRelationshipIds = optionalF287StringArray(approval, 'materializedRelationshipIds');
  const materializedEventIds = optionalF287StringArray(approval, 'materializedEventIds');
  if (
    materializedClaimIds.length !== 1 ||
    materializedRelationshipIds.length !== 1 ||
    materializedEventIds.length !== 1
  ) {
    throw new Error('approve did not materialize identity, relationship and interaction surfaces');
  }
  return {
    proposalId,
    proposalStatus,
    approvalStatus,
    personId: requireF287String(approval, 'personId', 'approve'),
    selectedDraftIds,
    materializedClaimIds,
    materializedRelationshipIds,
    materializedEventIds,
  };
}

async function verifyInitialRecall(
  input: F287PersonMemoryLifecycleUatInput,
  origin: string,
  fixture: F287AlphaOwnerFixture,
  prepared: PreparedLifecycle,
): Promise<string> {
  const firstRecall = await f287CallbackRequest(
    input,
    origin,
    'first recall',
    '/api/callbacks/person-memory/recall',
    'POST',
    { alias: fixture.displayName },
  );
  const firstCard = resolvedCard(firstRecall, 'first recall');
  if (requireF287String(firstCard, 'personId', 'first recall') !== prepared.personId) {
    throw new Error('first recall resolved a different person');
  }
  if (requireF287String(firstCard, 'displayName', 'first recall') !== fixture.displayName) {
    throw new Error('first recall did not preserve identity');
  }
  if (typeof firstCard.relationshipLine !== 'string' || firstCard.relationshipLine.length === 0) {
    throw new Error('first recall did not preserve relationship');
  }
  const firstInteraction = requireF287Record(firstCard.latestInteraction, 'first recall');
  if (requireF287String(firstInteraction, 'headline', 'first recall') !== fixture.interactionHeadline) {
    throw new Error('first recall did not preserve interaction');
  }
  const initialClaimId = prepared.materializedClaimIds[0];
  const initialFact = cardFacts(firstCard, 'first recall').find((fact) => fact.claimId === initialClaimId);
  if (!initialFact || !factText(initialFact, 'first recall').includes(fixture.initialFactValue)) {
    throw new Error('first recall did not preserve the initial claim');
  }
  return initialClaimId;
}

async function correctAndVerifyRecall(
  input: F287PersonMemoryLifecycleUatInput,
  origin: string,
  runId: string,
  fixture: F287AlphaOwnerFixture,
  personId: string,
  initialClaimId: string,
): Promise<void> {
  const correction = await f287CallbackRequest(
    input,
    origin,
    'correct',
    '/api/callbacks/person-memory/correct-claim',
    'POST',
    {
      personId,
      expectedCurrentClaimId: initialClaimId,
      payload: {
        kind: 'reported_fact',
        predicate: 'project_role',
        value: fixture.correctedFactValue,
        assertedBy: 'owner',
      },
      requestId: `f287-alpha-correct-${runId}`,
    },
  );
  if (requireF287String(correction, 'outcome', 'correct') !== 'applied') throw new Error('correct did not apply');
  const correctedClaimId = requireF287String(requireF287Record(correction.claim, 'correct'), 'claimId', 'correct');
  const updatedRecall = await f287CallbackRequest(
    input,
    origin,
    'updated recall',
    '/api/callbacks/person-memory/recall',
    'POST',
    { alias: fixture.displayName },
  );
  const updatedFacts = cardFacts(resolvedCard(updatedRecall, 'updated recall'), 'updated recall');
  const correctedFact = updatedFacts.find((fact) => fact.claimId === correctedClaimId);
  const isReplaced =
    correctedFact !== undefined &&
    factText(correctedFact, 'updated recall').includes(fixture.correctedFactValue) &&
    updatedFacts.every((fact) => !factText(fact, 'updated recall').includes(fixture.initialFactValue));
  if (!isReplaced) throw new Error('updated recall did not replace the superseded claim');
}

async function forgetAndVerifyZeroRecall(
  input: F287PersonMemoryLifecycleUatInput,
  origin: string,
  runId: string,
  fixture: F287AlphaOwnerFixture,
  personId: string,
): Promise<void> {
  const forget = await f287CallbackRequest(input, origin, 'forget', '/api/callbacks/person-memory/forget', 'POST', {
    personId,
    requestId: `f287-alpha-forget-${runId}`,
  });
  if (requireF287String(forget, 'verdict', 'forget') !== 'purged') throw new Error('forget did not purge the person');
  const finalRecall = await f287CallbackRequest(
    input,
    origin,
    'final recall',
    '/api/callbacks/person-memory/recall',
    'POST',
    { alias: fixture.displayName },
  );
  if (requireF287String(finalRecall, 'status', 'final recall') !== 'not_available') {
    throw new Error('final recall was not empty after hard forget');
  }
}

export async function runF287PersonMemoryLifecycleUat(
  input: F287PersonMemoryLifecycleUatInput,
): Promise<F287PersonMemoryLifecycleUatResult> {
  const origin = requireF287AlphaOrigin(input.baseUrl);
  const runId = validateF287RunId(input.runId);
  for (const [name, value] of Object.entries({
    invocationId: input.invocationId,
    callbackToken: input.callbackToken,
    ownerUserId: input.ownerUserId,
  })) {
    if (!value.trim()) throw new Error(`${name} is required`);
  }
  const fixture = buildF287AlphaOwnerFixture(runId);
  const prepared = await prepareLifecycle(input, origin, runId, fixture);
  const initialClaimId = await verifyInitialRecall(input, origin, fixture, prepared);
  await correctAndVerifyRecall(input, origin, runId, fixture, prepared.personId, initialClaimId);
  await forgetAndVerifyZeroRecall(input, origin, runId, fixture, prepared.personId);
  return {
    fixtureRevision: F287_PERSON_MEMORY_FIXTURE_REVISION,
    environment: 'alpha',
    proposalId: prepared.proposalId,
    personId: prepared.personId,
    statuses: {
      proposal: prepared.proposalStatus,
      approval: prepared.approvalStatus,
      firstRecall: 'resolved',
      correction: 'applied',
      updatedRecall: 'resolved',
      forget: 'purged',
      finalRecall: 'not_available',
    },
    selectedDraftCount: prepared.selectedDraftIds.length,
    materialized: {
      claimCount: prepared.materializedClaimIds.length,
      relationshipCount: prepared.materializedRelationshipIds.length,
      eventCount: prepared.materializedEventIds.length,
    },
    assertions: {
      identityPresent: true,
      relationshipPresent: true,
      interactionPresent: true,
      correctionReplacedClaim: true,
      finalForgetZero: true,
      historicalRejectedAldenCounted: false,
    },
  };
}
