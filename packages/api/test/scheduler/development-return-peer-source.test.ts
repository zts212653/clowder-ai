import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ThreadProposal } from '@cat-cafe/shared';
import { createDevelopmentReturnFixture } from '../helpers/development-return-fixture.js';

function peerFixture(t: Parameters<typeof createDevelopmentReturnFixture>[0]) {
  return createDevelopmentReturnFixture(t, {
    ownerCatId: 'codex-astra',
    proposalDelegateCatId: 'kimi',
    catAuthoredProposalSource: true,
    proposalTriggerCatId: 'codex-sol',
  });
}

test('Task owner registers an approved child triggered by another cat cross-posting to that owner', async (t) => {
  const fixture = await peerFixture(t);
  assert.ok(fixture.child.createdFromProposalId);
  const proposal = fixture.proposals.get(fixture.child.createdFromProposalId);
  assert.ok(proposal);
  assert.equal(proposal.sourceCatId, fixture.actor.catId);
  assert.notEqual(fixture.proposalSource.catId, fixture.actor.catId);
  assert.equal(fixture.proposalSource.origin, 'callback');
  assert.equal(fixture.proposalSource.extra?.crossPost?.sourceThreadId, fixture.peerTriggerSourceThread?.id);
  assert.ok(fixture.proposalSource.extra?.targetCats?.includes(fixture.actor.catId));
  assert.equal(fixture.input.sourceActionRef, `message:${fixture.source.id}`);

  const registration = await fixture.service.register(fixture.actor, fixture.input, 'strict');

  assert.equal(registration.proposalId, proposal.proposalId);
  assert.equal(registration.executionThreadId, fixture.child.id);
  assert.equal(registration.sourceActionRef, `message:${fixture.source.id}`);
  assert.equal(registration.status, 'waiting');
});

const invalidPeerTriggerRelations = [
  'foreign user',
  'foreign target thread',
  'missing cross-post provenance',
  'missing source invocation',
  'non-callback cross-post shape',
  'same-thread pseudo cross-post',
  'cross-post not addressed to owner',
  'proposal source cat drift',
  'connector source',
  'deleted trigger',
  'unapproved proposal',
  'wrong approved scope',
] as const;

for (const scenario of invalidPeerTriggerRelations) {
  test(`approved peer-trigger relation rejects ${scenario}`, async (t) => {
    const fixture = await peerFixture(t);
    const proposalId = fixture.child.createdFromProposalId;
    assert.ok(proposalId);
    const canonicalProposal = fixture.proposals.get(proposalId);
    assert.ok(canonicalProposal);
    assert.ok(fixture.proposalSource.catId);
    switch (scenario) {
      case 'foreign user':
        fixture.proposalSource.userId = 'other-user';
        break;
      case 'foreign target thread':
        fixture.proposalSource.threadId = 'thread-other-target';
        break;
      case 'missing cross-post provenance':
        fixture.proposalSource.extra = { targetCats: [fixture.actor.catId] };
        break;
      case 'missing source invocation':
        assert.ok(fixture.proposalSource.extra?.crossPost);
        delete fixture.proposalSource.extra.crossPost.sourceInvocationId;
        break;
      case 'non-callback cross-post shape':
        fixture.proposalSource.origin = undefined;
        break;
      case 'same-thread pseudo cross-post':
        assert.ok(fixture.proposalSource.extra?.crossPost);
        fixture.proposalSource.extra.crossPost.sourceThreadId = fixture.proposalSource.threadId;
        break;
      case 'cross-post not addressed to owner':
        assert.ok(fixture.proposalSource.extra);
        fixture.proposalSource.extra.targetCats = ['sonnet'];
        break;
      case 'proposal source cat drift':
        fixture.service.deps.proposals = {
          get: async (id) =>
            id === proposalId
              ? { ...canonicalProposal, sourceCatId: fixture.proposalSource.catId }
              : fixture.proposals.get(id),
        };
        break;
      case 'connector source':
        fixture.proposalSource.source = { connector: 'test', label: 'forwarded' };
        break;
      case 'deleted trigger':
        assert.ok(fixture.messages.softDelete(fixture.proposalSource.id, fixture.actor.userId));
        break;
      case 'unapproved proposal':
        fixture.service.deps.proposals = {
          get: async (id) =>
            id === proposalId
              ? { ...canonicalProposal, status: 'pending' as const, approvedAt: undefined }
              : fixture.proposals.get(id),
        };
        break;
      case 'wrong approved scope':
        fixture.service.deps.proposals = {
          get: async (id) =>
            id === proposalId
              ? {
                  ...canonicalProposal,
                  approvedDevelopmentScope: {
                    ...canonicalProposal.approvedDevelopmentScope,
                    acceptedRevision: 'b'.repeat(40),
                  } as NonNullable<ThreadProposal['approvedDevelopmentScope']>,
                }
              : fixture.proposals.get(id),
        };
        break;
    }

    await assert.rejects(fixture.service.register(fixture.actor, fixture.input, 'strict'));
    assert.equal(fixture.service.readForActor(fixture.actor).length, 0);
  });
}

for (const mutation of ['author', 'source thread', 'source invocation', 'target owner'] as const) {
  test(`peer-triggered return retires when its ${mutation} relation changes`, async (t) => {
    const fixture = await peerFixture(t);
    const registration = await fixture.service.register(fixture.actor, fixture.input, 'strict');
    const crossPost = fixture.proposalSource.extra?.crossPost;
    assert.ok(crossPost);
    switch (mutation) {
      case 'author':
        fixture.proposalSource.catId = 'sonnet';
        break;
      case 'source thread':
        crossPost.sourceThreadId = 'thread-other-source';
        break;
      case 'source invocation':
        crossPost.sourceInvocationId = 'inv-other-source';
        break;
      case 'target owner':
        assert.ok(fixture.proposalSource.extra);
        fixture.proposalSource.extra.targetCats = ['sonnet'];
        break;
    }

    fixture.tick(20_000);
    await fixture.runner.triggerNow(registration.registrationId);

    assert.equal(fixture.service.read(registration.registrationId)?.status, 'retired');
    assert.equal(fixture.wakes.length, 0);
  });
}
