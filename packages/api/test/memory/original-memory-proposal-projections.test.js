import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import Fastify from 'fastify';
import { entityMemoryOwnerRoutes } from '../../dist/routes/entity-memory-owner.js';
import { personMemoryOwnerReadRoutes } from '../../dist/routes/person-memory-owner-read.js';
import { profileMemoryOwnerRoutes } from '../../dist/routes/profile-memory-owner.js';

const ownerUserId = 'owner-proposal-projection';
const revision = `sha256:${'a'.repeat(64)}`;

function ownerApp() {
  const app = Fastify();
  app.addHook('preHandler', async (request) => {
    request.sessionUserId = request.headers['x-test-session'];
  });
  return app;
}

const headers = { 'x-test-session': ownerUserId };

describe('F321 original-memory proposal projections', () => {
  it('keeps Profile and Entity target queries owner-scoped across proposal states', async () => {
    const [{ InMemoryProfileUpdateProposalStore }, { InMemoryEntityProposalStore }] = await Promise.all([
      import('../../dist/domains/cats/services/stores/ports/ProfileUpdateProposalStore.js'),
      import('../../dist/domains/approval-hub/stores/ports/IEntityProposalStore.js'),
    ]);
    const profileStore = new InMemoryProfileUpdateProposalStore();
    const profileInput = (createdBy, targetPath) => ({
      sourceThreadId: 'thread-profile-query',
      sourceInvocationId: 'invocation-profile-query',
      sourceCatId: 'codex-sol',
      targetLayer: targetPath.startsWith('corpus/') ? 'corpus' : 'primer',
      targetPath,
      beforeContent: 'old',
      baseContentHash: 'a'.repeat(64),
      afterContent: 'new',
      rationale: 'target query',
      signalProvenance: { kind: 'cat-declared', sourceThreadId: 'thread-profile-query' },
      createdBy,
    });
    const profileTarget = profileStore.create(profileInput(ownerUserId, 'corpus/shared-facts.md'));
    profileStore.create(profileInput(ownerUserId, 'relationship/other-primer.md'));
    profileStore.create(profileInput('other-owner', 'corpus/shared-facts.md'));
    profileStore.claimForApproval(profileTarget.proposalId, ownerUserId);
    assert.deepEqual(
      profileStore.listByTarget(ownerUserId, 'corpus/shared-facts.md').map(({ proposalId, status }) => ({
        proposalId,
        status,
      })),
      [{ proposalId: profileTarget.proposalId, status: 'approving' }],
    );

    const entityStore = new InMemoryEntityProposalStore();
    const entityInput = (owner, entityId) => ({
      entityId,
      entityType: 'concept',
      canonicalName: entityId,
      aliases: [],
      stance: 'unknown',
      visibilityScope: 'workspace',
      provenance: [{ source: 'test' }],
      rationale: 'target query',
      sourceThreadId: 'thread-entity-query',
      sourceCatId: 'codex-sol',
      ownerUserId: owner,
    });
    const entityTarget = entityStore.create(entityInput(ownerUserId, 'concept:target'));
    entityStore.create(entityInput(ownerUserId, 'concept:other'));
    entityStore.create(entityInput('other-owner', 'concept:target'));
    entityStore.markApproved(entityTarget.proposalId, ownerUserId);
    assert.deepEqual(
      entityStore.listByTarget(ownerUserId, 'concept:target').map(({ proposalId, status }) => ({
        proposalId,
        status,
      })),
      [{ proposalId: entityTarget.proposalId, status: 'approved' }],
    );
  });

  it('attaches only the owner profile proposals bound to the exact profile target', async () => {
    const calls = [];
    const entry = {
      id: 'corpus',
      type: 'profile',
      layer: 'corpus',
      relationshipKey: null,
      uri: 'cat-cafe-profile://corpus/current',
      title: '共同事实',
      status: 'active',
      revision,
      content: 'old profile',
      targetPath: 'corpus/shared-facts.md',
    };
    const app = ownerApp();
    await app.register(profileMemoryOwnerRoutes, {
      ownerUserId,
      store: { list: () => [entry], get: () => entry },
      proposalStore: {
        listByTarget: async (owner, targetPath) => {
          calls.push([owner, targetPath]);
          return [
            {
              proposalId: 'profile-proposal-1',
              status: 'pending',
              sourceThreadId: 'thread-profile-proposal',
              sourceCatId: 'codex-sol',
              targetLayer: 'corpus',
              targetPath,
              baseContentHash: 'a'.repeat(64),
              afterContent: 'new profile',
              rationale: 'The source corrected the profile.',
              createdBy: owner,
              createdAt: 20,
              publication: {
                state: 'anchored',
                envelope: {
                  approvalCardRef: { threadId: 'thread-profile-card', messageId: 'profile-card-message' },
                },
              },
            },
          ];
        },
      },
      sourceReaders: { threadStore: {}, messageStore: {} },
    });
    await app.ready();

    const list = await app.inject({ url: '/api/memory/profile', headers });
    assert.equal(list.statusCode, 200, list.body);
    assert.deepEqual(list.json().entries[0].proposals, [
      {
        proposalId: 'profile-proposal-1',
        status: 'pending',
        expectedRevision: revision,
        suggestedContent: 'new profile',
        rationale: 'The source corrected the profile.',
        sourceCatId: 'codex-sol',
        sourceThreadId: 'thread-profile-proposal',
        createdAt: 20,
        decisionEndpointBase: '/api/profile-updates',
        approvalState: 'anchored',
        approvalCardRef: { threadId: 'thread-profile-card', messageId: 'profile-card-message' },
      },
    ]);
    assert.deepEqual(calls, [
      [ownerUserId, 'corpus/shared-facts.md'],
      [ownerUserId, 'capsule.md'],
    ]);
    assert.equal(list.json().capsuleSetup.proposals[0].suggestedContent, 'new profile');
    assert.equal(
      list.json().entries.some((entry) => entry.id === 'capsule'),
      false,
      'a draft is not active memory',
    );
    await app.close();
  });

  it('attaches exact owner/entity proposals to the entity detail without changing the entity lane', async () => {
    const entity = {
      entityId: 'concept:proposal-projection',
      type: 'concept',
      canonicalName: 'Old name',
      aliases: ['old alias'],
      provenance: [],
      stance: 'unknown',
      visibilityScope: 'workspace',
      status: 'active',
      createdAt: '2026-10-06T00:00:00.000Z',
      updatedAt: '2026-10-06T00:00:00.000Z',
    };
    const calls = [];
    const app = ownerApp();
    await app.register(entityMemoryOwnerRoutes, {
      ownerUserId,
      store: { list: () => [entity], get: () => entity },
      proposalStore: {
        listByTarget: async (owner, entityId) => {
          calls.push([owner, entityId]);
          return [
            {
              proposalId: 'entity-proposal-1',
              status: 'pending',
              entityId,
              entityType: 'concept',
              canonicalName: 'Correct name',
              aliases: ['correct alias'],
              stance: 'endorsed',
              visibilityScope: 'workspace',
              rationale: 'Use the source-backed name.',
              sourceThreadId: 'thread-entity-proposal',
              sourceCatId: 'codex-sol',
              ownerUserId: owner,
              createdAt: 30,
              publication: {
                state: 'anchored',
                envelope: {
                  approvalCardRef: { threadId: 'thread-entity-card', messageId: 'entity-card-message' },
                },
              },
            },
          ];
        },
      },
      sourceReaders: { threadStore: {}, messageStore: {} },
    });
    await app.ready();

    const response = await app.inject({
      url: `/api/memory/entities/${encodeURIComponent(entity.entityId)}`,
      headers,
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(response.json().proposals, [
      {
        proposalId: 'entity-proposal-1',
        status: 'pending',
        suggestedPatch: {
          entityType: 'concept',
          canonicalName: 'Correct name',
          aliases: ['correct alias'],
          stance: 'endorsed',
          visibilityScope: 'workspace',
        },
        rationale: 'Use the source-backed name.',
        sourceCatId: 'codex-sol',
        sourceThreadId: 'thread-entity-proposal',
        createdAt: 30,
        decisionEndpointBase: '/api/entity-proposals',
        approvalState: 'anchored',
        approvalCardRef: { threadId: 'thread-entity-card', messageId: 'entity-card-message' },
      },
    ]);
    assert.deepEqual(calls, [[ownerUserId, entity.entityId]]);
    await app.close();
  });

  it('uses the existing owner/person reverse index for the original person proposal entry', async () => {
    const personId = 'person_proposal_projection';
    const person = {
      personId,
      ownerUserId,
      displayName: 'Original person',
      privateAliases: [],
      status: 'active',
      createdAt: 10,
      sourceRefs: [],
    };
    const candidate = {
      candidateId: 'person_candidate_proposal_projection',
      ownerUserId,
      requesterCatId: 'codex-sol',
      sourceMessageRef: { kind: 'message', threadId: 'thread-person-proposal', messageId: 'message-proposal' },
      targetPersonId: personId,
      personDraft: { displayName: 'Original person', privateAliases: [] },
      claimDrafts: [],
      remainingDraftIds: ['person_draft_proposal_projection'],
      retention: 'owner_controlled_no_ttl',
      createdAt: 40,
      state: 'pending_approval',
      publication: {
        state: 'anchored',
        envelope: { approvalCardRef: { threadId: 'thread-person-card', messageId: 'person-card-message' } },
      },
    };
    const calls = [];
    const store = {
      listPeople: async () => [person],
      getPerson: async (owner, id) => (owner === ownerUserId && id === personId ? person : null),
      listClaims: async () => [],
      listRelationships: async () => [],
      listInteractionEvents: async () => [],
      listCandidateIdsForPerson: async (owner, id) => {
        calls.push([owner, id]);
        return [candidate.candidateId, 'person_candidate_foreign_target'];
      },
      getCandidateForOwner: async (_owner, id) =>
        id === candidate.candidateId ? candidate : { ...candidate, candidateId: id, targetPersonId: 'person_other' },
    };
    const app = ownerApp();
    await app.register(personMemoryOwnerReadRoutes, {
      ownerUserId,
      store,
      messageStore: { getById: async () => null },
      threadStore: { get: async () => null, list: async () => [] },
    });
    await app.ready();

    const response = await app.inject({ url: `/api/memory/people/${personId}`, headers });
    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(response.json().proposals, [
      {
        proposalId: candidate.candidateId,
        status: 'pending_approval',
        displayName: 'Original person',
        remainingDraftIds: ['person_draft_proposal_projection'],
        sourceCatId: 'codex-sol',
        sourceThreadId: 'thread-person-proposal',
        createdAt: 40,
        decisionEndpointBase: '/api/person-memory-proposals',
        approvalState: 'anchored',
        approvalCardRef: { threadId: 'thread-person-card', messageId: 'person-card-message' },
      },
    ]);
    assert.deepEqual(calls, [[ownerUserId, personId]]);
    await app.close();
  });
});
