import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hasHistoricalBodyApproval } from '../src/domains/memory/people/historical-body-source-proof.ts';
import { OwnerMemoryActionService } from '../src/domains/memory/people/OwnerMemoryActionService.ts';
import { PersonMemoryOwnerReadService } from '../src/domains/memory/people/PersonMemoryOwnerReadService.ts';
import {
  digestPersonMemorySourceMaterial,
  PersonMemorySourceBundleResolver,
} from '../src/domains/memory/people/PersonMemorySourceBundleResolver.ts';
import { personClaimOwnerRevision } from '../src/domains/memory/people/person-memory-owner-revision.ts';
import {
  binding,
  body,
  clean,
  excerpt,
  fixture,
  historicalBodyDigest,
  owner,
  quote,
  ref,
} from './helpers/person-memory-body-proof-fixture.js';

test('an unchanged stored body proof remains readable when the message also has a quote comment', async () => {
  const f = fixture();
  const result = await f.read();
  assert.deepEqual({ status: result.status, reasons: f.reasons }, { status: 'ready', reasons: [] });
  assert.deepEqual(
    result.sources.map((s) => ({ threadId: s.threadId, messageId: s.messageId })),
    [{ threadId: ref.threadId, messageId: ref.messageId }],
  );
  assert.equal(f.item.typedProvenance.sources[0].resolvedDigest, historicalBodyDigest);
});

test('a proven historical body source still authorizes the native claim correction service', async () => {
  const f = fixture();
  const person = { personId: 'person_historical', ownerUserId: owner, status: 'active' };
  const claim = {
    ...f.item,
    personId: person.personId,
    claimId: 'person_claim_historical',
    status: 'current',
    payload: { kind: 'reported_fact', predicate: 'owns', value: 'notebook', assertedBy: 'owner' },
  };
  const evidence = [];
  const service = new OwnerMemoryActionService({
    ...f.deps,
    store: {
      getPerson: async () => person,
      listClaims: async () => [claim],
      resolveOwnerActionReplay: async () => ({ outcome: 'none' }),
      executeOwnerAction: async (input) => {
        evidence.push(input.evidence);
        return { action: 'correct_claim', outcome: 'applied' };
      },
    },
  });
  const result = await service.execute(
    { ownerUserId: owner, sessionBindingId: 'session-history', csrfToken: 'csrf-history' },
    {
      action: 'correct_claim',
      personId: person.personId,
      claimId: claim.claimId,
      requestId: 'request-history',
      expectedRevision: personClaimOwnerRevision(claim),
      payload: { ...claim.payload, value: 'desk' },
    },
  );
  assert.equal(result.outcome, 'applied');
  assert.equal(evidence.length, 1);
  assert.equal(evidence[0].sourceState, 'live');
});

test('relationship source reads retain canonical transition approval history', async () => {
  const f = fixture();
  const person = { personId: 'person_historical', ownerUserId: owner, status: 'active' };
  const relationship = {
    relationshipId: 'relationship_historical',
    personId: person.personId,
    ownerUserId: owner,
    status: 'current',
    transitions: [{ ...f.item, status: 'current' }],
  };
  const service = new PersonMemoryOwnerReadService({
    ...f.deps,
    store: {
      getPerson: async () => person,
      listRelationships: async () => [relationship],
    },
  });
  assert.equal(
    (await service.readSource(owner, person.personId, { kind: 'relationship', itemId: relationship.relationshipId }))
      .status,
    'ready',
  );
  relationship.transitions[0].recordedAt++;
  assert.deepEqual(
    await service.readSource(owner, person.personId, { kind: 'relationship', itemId: relationship.relationshipId }),
    { status: 'unavailable' },
  );
});

test('body-proof compatibility is not accepted for new capture', async () => {
  const f = fixture();
  const result = await new PersonMemorySourceBundleResolver(f.deps).resolve(
    {
      sources: [
        {
          sourceId: 'source-1',
          kind: 'message_text',
          messageId: ref.messageId,
          expectedDigest: historicalBodyDigest,
          excerpt,
        },
      ],
      assertionBindings: [{ ...binding, target: { kind: 'claim', index: 0 } }],
    },
    { ownerUserId: owner },
    { claimDraftIds: ['person_draft_body'] },
  );
  assert.deepEqual(result, { status: 'invalid', error: 'source_digest_mismatch' });
});

for (const [name, change] of [
  [
    'missing history',
    (item) => {
      delete item.recordedAt;
      delete item.materializedBy;
    },
  ],
  [
    'new approval',
    (item) => {
      item.recordedAt = item.materializedBy.authorizedAt = Date.UTC(2026, 10, 13);
    },
  ],
  [
    'at the format boundary',
    (item) => {
      item.recordedAt = item.materializedBy.authorizedAt = Date.parse('2026-09-25T00:46:36Z');
    },
  ],
  [
    'mismatched stored times',
    (item) => {
      item.recordedAt++;
    },
  ],
  [
    'non-card authority',
    (item) => {
      item.materializedBy = { ...item.materializedBy, kind: 'anchored_correction' };
    },
  ],
  [
    'nonfinite time',
    (item) => {
      item.recordedAt = item.materializedBy.authorizedAt = Number.NaN;
    },
  ],
]) {
  test(`a body hash cannot prove historical format with ${name}`, async () => {
    const f = fixture();
    change(f.item);
    assert.deepEqual(await f.read(), { status: 'unavailable' });
  });
}

test('historical approval belongs to the canonical record owner', () => {
  const f = fixture();
  assert.equal(hasHistoricalBodyApproval(f.item, owner), true);
  assert.equal(hasHistoricalBodyApproval(f.item, 'another-owner'), false);
});

for (const [name, change] of [
  ['body edited outside the excerpt', (f) => f.setMessage({ ...clean, content: `${body} Later changed.` })],
  [
    'quote comment as the alleged excerpt',
    (f) => {
      f.item.typedProvenance.sources[0].excerpt = quote.attachment.comment;
    },
  ],
  [
    'quoted third-party text as the alleged excerpt',
    (f) => {
      f.item.typedProvenance.sources[0].excerpt = quote.attachment.text;
    },
  ],
  [
    'ambiguous body and comment excerpt',
    (f) =>
      f.setMessage({ ...clean, contentBlocks: [{ ...quote, attachment: { ...quote.attachment, comment: excerpt } }] }),
  ],
  [
    'wrong digest',
    (f) => {
      f.item.typedProvenance.sources[0].resolvedDigest = 'f'.repeat(64);
    },
  ],
  ['source message moved', (f) => f.setMessage({ ...clean, threadId: 'different-thread' })],
  ['source owner changed', (f) => f.setMessage({ ...clean, userId: 'other-owner' })],
  ['message deleted', (f) => f.setMessage({ ...clean, deletedAt: 2 })],
  ['message tombstoned', (f) => f.setMessage({ ...clean, _tombstone: true })],
  ['message missing', (f) => f.setMessage(null)],
  ['message not delivered', (f) => f.setMessage({ ...clean, deliveryStatus: 'queued' })],
  ['cat sender', (f) => f.setMessage({ ...clean, catId: 'codex61-sol', from: { kind: 'cat', catId: 'codex61-sol' } })],
  ['thread deleted', (f) => f.setThread({ id: ref.threadId, createdBy: owner, deletedAt: 2 })],
  ['thread belongs to another owner', (f) => f.setThread({ id: ref.threadId, createdBy: 'other-owner' })],
]) {
  test(`stored body proof still rejects ${name}`, async () => {
    const f = fixture();
    change(f);
    assert.deepEqual(await f.read(), { status: 'unavailable' });
    assert.equal(f.reasons.length, 1);
  });
}

test('new quote-aware proofs continue to reject quote attachment drift', async () => {
  const f = fixture();
  const resolver = new PersonMemorySourceBundleResolver(f.deps);
  const captured = await resolver.resolve(
    {
      sources: [{ sourceId: 'source-1', kind: 'message_text', messageId: ref.messageId, excerpt }],
      assertionBindings: [{ ...binding, target: { kind: 'claim', index: 0 } }],
    },
    { ownerUserId: owner },
    { claimDraftIds: ['person_draft_body'] },
  );
  assert.equal(captured.status, 'resolved');
  f.item.typedProvenance = captured.bundle;
  assert.equal((await f.read()).status, 'ready');
  f.setMessage({
    ...clean,
    contentBlocks: [{ ...quote, attachment: { ...quote.attachment, text: 'Edited quoted material.' } }],
  });
  assert.deepEqual(await f.read(), { status: 'unavailable' });
  assert.deepEqual(f.reasons, ['source_digest_mismatch']);
});

for (const kind of ['owner_confirmed_transcript', 'owner_private_artifact']) {
  test(`stored ${kind} also preserves an exact historical body confirmation`, async () => {
    const f = fixture();
    const confirmation = { ...clean, content: '是的，记录内容准确。' };
    f.setMessage(confirmation);
    const artifact = {
      digest: digestPersonMemorySourceMaterial('original artifact'),
      boundedText: 'original artifact',
    };
    f.deps.ownerPrivateArtifactResolver = { resolve: async () => artifact };
    const common = { sourceId: 'source-1', kind, ownerUserId: owner, confirmationSourceRef: ref };
    const source =
      kind === 'owner_confirmed_transcript'
        ? {
            ...common,
            transcript: 'original transcript',
            confirmationScope: 'transcript_accuracy',
            resolvedDigest: digestPersonMemorySourceMaterial({
              transcript: 'original transcript',
              confirmation: confirmation.content.normalize('NFKC').trim(),
            }),
          }
        : {
            ...common,
            artifactLocator: 'workspace:body-proof',
            boundedExcerpt: 'original artifact',
            resolvedDigest: digestPersonMemorySourceMaterial({
              artifactDigest: artifact.digest,
              confirmation: confirmation.content.normalize('NFKC').trim(),
            }),
          };
    f.item.typedProvenance.sources = [source];
    assert.equal((await f.read()).status, 'ready');
    f.setMessage({ ...confirmation, content: '对，记录内容准确。但正文已编辑。' });
    assert.deepEqual(await f.read(), { status: 'unavailable' });
  });

  test(`stored ${kind} cannot use a body proof to authenticate comment-only confirmation`, async () => {
    const f = fixture();
    const confirmation = {
      ...clean,
      content: 'Unconfirmed body.',
      contentBlocks: [{ ...quote, attachment: { ...quote.attachment, comment: '是的，记录内容准确。' } }],
    };
    f.setMessage(confirmation);
    const artifact = {
      digest: digestPersonMemorySourceMaterial('original artifact'),
      boundedText: 'original artifact',
    };
    f.deps.ownerPrivateArtifactResolver = { resolve: async () => artifact };
    const source =
      kind === 'owner_confirmed_transcript'
        ? {
            sourceId: 'source-1',
            kind,
            ownerUserId: owner,
            confirmationSourceRef: ref,
            transcript: 'original transcript',
            confirmationScope: 'transcript_accuracy',
            resolvedDigest: digestPersonMemorySourceMaterial({
              transcript: 'original transcript',
              confirmation: confirmation.content.normalize('NFKC').trim(),
            }),
          }
        : {
            sourceId: 'source-1',
            kind,
            ownerUserId: owner,
            confirmationSourceRef: ref,
            artifactLocator: 'workspace:body-proof',
            boundedExcerpt: 'original artifact',
            resolvedDigest: digestPersonMemorySourceMaterial({
              artifactDigest: artifact.digest,
              confirmation: confirmation.content.normalize('NFKC').trim(),
            }),
          };
    f.item.typedProvenance.sources = [source];
    assert.deepEqual(await f.read(), { status: 'unavailable' });
  });
}
