import assert from 'node:assert/strict';
import { test } from 'node:test';
import { OwnerMemoryActionService } from '../src/domains/memory/people/OwnerMemoryActionService.ts';
import { PersonMemoryOwnerSourceReader } from '../src/domains/memory/people/PersonMemoryOwnerSourceReader.ts';
import {
  digestPersonMemorySourceMaterial,
  PersonMemorySourceBundleResolver,
} from '../src/domains/memory/people/PersonMemorySourceBundleResolver.ts';
import { personClaimOwnerRevision } from '../src/domains/memory/people/person-memory-owner-revision.ts';

const owner = 'owner-drift';
const now = Date.UTC(2026, 10, 13);
const beforeQuoteProofs = Date.UTC(2026, 8, 24);
const ref = { kind: 'message', threadId: 'thread-proof-drift', messageId: 'message-proof-drift' };
const quote = {
  type: 'context_attachment',
  attachment: {
    v: 1,
    id: 'ctx-proof-drift',
    kind: 'quote',
    text: 'third-party text',
    comment: '刚才我说的是假的',
    source: { kind: 'message', threadId: 'quoted-thread', messageId: 'quoted-message' },
  },
};
const original = {
  id: ref.messageId,
  threadId: ref.threadId,
  userId: owner,
  catId: null,
  from: { kind: 'user', userId: owner },
  content: '是的，记录内容准确。Mira owns the blue notebook.',
  contentBlocks: [],
  timestamp: 1,
  deliveryStatus: 'delivered',
};
const artifact = { digest: digestPersonMemorySourceMaterial('artifact'), boundedText: 'artifact' };
const inputs = [
  { kind: 'message_text', messageId: ref.messageId, excerpt: 'Mira owns the blue notebook' },
  {
    kind: 'owner_confirmed_transcript',
    transcript: 'transcript',
    transcriptDigest: digestPersonMemorySourceMaterial('transcript'),
    confirmationMessageId: ref.messageId,
    confirmationScope: 'transcript_accuracy',
  },
  {
    kind: 'owner_private_artifact',
    artifactLocator: 'workspace:proof-drift',
    expectedDigest: artifact.digest,
    boundedExcerpt: 'artifact',
    confirmationMessageId: ref.messageId,
  },
];

async function fixture(input, history = 'current') {
  let message = structuredClone(original);
  let executions = 0;
  const deps = {
    messageStore: { getById: async () => message },
    threadStore: { get: async () => ({ id: ref.threadId, createdBy: owner }), list: async () => [] },
    ownerPrivateArtifactResolver: { resolve: async () => artifact },
  };
  const captured = await new PersonMemorySourceBundleResolver(deps).resolve(
    {
      sources: [{ sourceId: 'source-1', ...input }],
      assertionBindings: [{ sourceId: 'source-1', target: { kind: 'claim', index: 0 }, role: 'reported_fact' }],
    },
    { ownerUserId: owner },
    { claimDraftIds: ['person_draft_drift'] },
  );
  assert.equal(captured.status, 'resolved');
  const person = { personId: 'person_drift', ownerUserId: owner, status: 'active' };
  const claim = {
    claimId: 'person_claim_drift',
    personId: person.personId,
    ownerUserId: owner,
    status: 'current',
    recordedAt: now,
    payload: { kind: 'reported_fact', predicate: 'owns', value: 'notebook', assertedBy: 'owner' },
    sourceRefs: [ref],
    typedProvenance: captured.bundle,
    materializedBy: {
      kind: 'card_approval',
      candidateId: 'person_candidate_drift',
      draftId: 'person_draft_drift',
      authorizedAt: now,
    },
  };
  if (history === 'missing') {
    delete claim.recordedAt;
    delete claim.materializedBy;
  }
  if (history === 'old-recorded-at-only') claim.recordedAt = beforeQuoteProofs;
  if (history === 'old-authority-only') claim.materializedBy.authorizedAt = beforeQuoteProofs;
  const store = {
    getPerson: async () => person,
    listClaims: async () => [claim],
    resolveOwnerActionReplay: async () => ({ outcome: 'none' }),
    executeOwnerAction: async () => {
      executions++;
      return { action: 'correct_claim', outcome: 'applied' };
    },
  };
  const action = new OwnerMemoryActionService({ ...deps, store, now: () => now });
  const command = {
    action: 'correct_claim',
    personId: person.personId,
    claimId: claim.claimId,
    requestId: 'request-drift',
    expectedRevision: personClaimOwnerRevision(claim),
    payload: { ...claim.payload, value: 'desk' },
  };
  return {
    addQuote: () => {
      message = { ...original, contentBlocks: [structuredClone(quote)] };
    },
    changeQuote: () => {
      message.contentBlocks[0].attachment.comment = '改过的引用评论';
    },
    read: () => new PersonMemoryOwnerSourceReader(deps).read(owner, claim),
    correct: () =>
      action.execute({ ownerUserId: owner, sessionBindingId: 'session-drift', csrfToken: 'csrf-drift' }, command),
    executions: () => executions,
  };
}

for (const input of inputs) {
  for (const history of ['current', 'missing', 'old-recorded-at-only', 'old-authority-only']) {
    test(`new ${input.kind} (${history}) rejects a later quote without treating it as historical`, async () => {
      const f = await fixture(input, history);
      assert.equal((await f.read()).status, 'ready');
      f.addQuote();
      assert.deepEqual(await f.read(), { status: 'unavailable' });
      f.changeQuote();
      assert.deepEqual(await f.read(), { status: 'unavailable' });
    });
  }
  test(`new ${input.kind} quote drift cannot authorize a claim correction`, async () => {
    const f = await fixture(input);
    f.addQuote();
    assert.equal((await f.correct()).outcome, 'source_unavailable');
    assert.equal(f.executions(), 0);
  });
}
