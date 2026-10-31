import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const ownerUserId = 'owner-1';

function entityProposal(overrides = {}) {
  return {
    proposalId: 'entity-proposal-1',
    status: 'pending',
    canonicalName: 'Alden',
    aliases: ['Alden K.'],
    visibilityScope: 'workspace',
    ownerUserId,
    createdAt: 10,
    ...overrides,
  };
}

function personCandidate(overrides = {}) {
  return {
    candidateId: 'person_candidate_alden',
    ownerUserId,
    personDraft: {
      displayName: 'Alden',
      privateAliases: ['Alden', 'Alden K.'],
    },
    ...overrides,
  };
}

function deps(overrides = {}) {
  return {
    entityRegistry: {
      resolveExactAlias: () => [],
    },
    entityProposalStore: {
      listPending: () => [],
      listSettledByUser: () => [],
    },
    personMemoryStore: {
      resolveActivePersonByAlias: async () => ({ status: 'not_available' }),
      resolvePendingCandidateBySubject: async () => null,
      resolveDormantCandidateBySubject: async () => null,
    },
    ...overrides,
  };
}

describe('ProactiveCandidateRegistryResolver', () => {
  it('uses exact active Entity aliases and preserves private visibility', async () => {
    const { SqliteEvidenceStore } = await import('../../dist/domains/memory/SqliteEvidenceStore.js');
    const evidenceStore = new SqliteEvidenceStore(':memory:');
    await evidenceStore.initialize();
    try {
      await evidenceStore.upsertEntities([
        {
          entityId: 'person:alden',
          type: 'person',
          canonicalName: 'Alden',
          aliases: ['Alden K.'],
          provenance: [{ source: 'F282 fixture' }],
          visibilityScope: 'workspace',
          status: 'active',
          updatedAt: '2026-07-30T00:00:00Z',
        },
        {
          entityId: 'person:private-alden',
          type: 'person',
          canonicalName: 'Private Alden',
          aliases: ['Secret Alden'],
          provenance: [{ source: 'F282 private fixture' }],
          visibilityScope: 'private:owner-1',
          status: 'active',
          updatedAt: '2026-07-30T00:00:00Z',
        },
      ]);
      const registry = evidenceStore.entityRegistry;
      assert.deepEqual(
        registry.resolveExactAlias('ＡＬＤＥＮ', 'owner-2').map((match) => match.entityId),
        ['person:alden'],
      );
      assert.deepEqual(
        registry.resolveExactAlias('Secret Alden', 'owner-1').map((match) => match.entityId),
        ['person:private-alden'],
      );
      assert.deepEqual(registry.resolveExactAlias('Secret Alden', 'owner-2'), []);
      assert.deepEqual(registry.resolveExactAlias('Alden K', 'owner-1'), []);
    } finally {
      evidenceStore.close();
    }
  });

  it('resolves exact registered entity then active owner-private person before proposal states', async () => {
    const { ProactiveCandidateRegistryResolver } = await import(
      '../../dist/domains/memory/ProactiveCandidateRegistryResolver.js'
    );
    const entityFirst = new ProactiveCandidateRegistryResolver(
      deps({
        entityRegistry: {
          resolveExactAlias: (phrase, owner) => {
            assert.equal(phrase, ' Alden ');
            assert.equal(owner, ownerUserId);
            return [
              {
                entityId: 'person:alden',
                type: 'person',
                matchedAlias: 'Alden',
              },
            ];
          },
        },
        personMemoryStore: {
          resolveActivePersonByAlias: async () => ({
            status: 'resolved',
            person: { personId: 'person_owner_alden' },
          }),
          resolvePendingCandidateBySubject: async () => personCandidate(),
          resolveDormantCandidateBySubject: async () => ({
            candidateId: 'person_candidate_rejected',
          }),
        },
      }),
    );
    assert.deepEqual(await entityFirst.resolve({ ownerUserId, phrase: ' Alden ' }), {
      kind: 'registered_entity',
      ref: 'person:alden',
    });

    const personSecond = new ProactiveCandidateRegistryResolver(
      deps({
        personMemoryStore: {
          resolveActivePersonByAlias: async () => ({
            status: 'resolved',
            person: { personId: 'person_owner_alden' },
          }),
          resolvePendingCandidateBySubject: async () => personCandidate(),
          resolveDormantCandidateBySubject: async () => null,
        },
      }),
    );
    assert.deepEqual(await personSecond.resolve({ ownerUserId, phrase: 'Alden' }), {
      kind: 'registered_person',
      ref: 'person_owner_alden',
    });
  });

  it('does not classify a non-person Entity as a registered person relationship subject', async () => {
    const { ProactiveCandidateRegistryResolver } = await import(
      '../../dist/domains/memory/ProactiveCandidateRegistryResolver.js'
    );
    const resolver = new ProactiveCandidateRegistryResolver(
      deps({
        entityRegistry: {
          resolveExactAlias: () => [
            {
              entityId: 'feature:f276',
              type: 'feature',
              canonicalName: 'F276',
              matchedAlias: 'F276',
              provenance: [],
            },
          ],
        },
      }),
    );

    assert.deepEqual(await resolver.resolve({ ownerUserId, phrase: 'F276' }), {
      kind: 'registered_non_person_entity',
      ref: 'feature:f276',
    });
  });

  it('fails closed when one exact alias resolves to multiple active person Entities', async () => {
    const { ProactiveCandidateRegistryResolver } = await import(
      '../../dist/domains/memory/ProactiveCandidateRegistryResolver.js'
    );
    const resolver = new ProactiveCandidateRegistryResolver(
      deps({
        entityRegistry: {
          resolveExactAlias: () => [
            {
              entityId: 'person:alden-primary',
              type: 'person',
              canonicalName: 'Alden',
              matchedAlias: 'Alden',
              provenance: [],
            },
            {
              entityId: 'person:alden-duplicate',
              type: 'person',
              canonicalName: 'Alden K.',
              matchedAlias: 'Alden',
              provenance: [],
            },
          ],
        },
      }),
    );

    assert.deepEqual(await resolver.resolve({ ownerUserId, phrase: 'Alden' }), {
      kind: 'unknown',
    });
  });

  it('resolves F260 and F276 exact pending subjects without substring matches', async () => {
    const { ProactiveCandidateRegistryResolver } = await import(
      '../../dist/domains/memory/ProactiveCandidateRegistryResolver.js'
    );
    const f260 = new ProactiveCandidateRegistryResolver(
      deps({
        entityProposalStore: {
          listPending: () => [
            entityProposal({ proposalId: 'entity-proposal-short', canonicalName: 'Al', aliases: [] }),
            entityProposal({ proposalId: 'entity-proposal-alden' }),
          ],
          listSettledByUser: () => [],
        },
      }),
    );
    assert.deepEqual(await f260.resolve({ ownerUserId, phrase: 'ＡＬＤＥＮ' }), {
      kind: 'pending_candidate',
      producerId: 'F260',
      proposalId: 'entity-proposal-alden',
    });

    const f276 = new ProactiveCandidateRegistryResolver(
      deps({
        personMemoryStore: {
          resolveActivePersonByAlias: async () => ({ status: 'not_available' }),
          resolvePendingCandidateBySubject: async (_owner, phrase) => (phrase === 'Alden' ? personCandidate() : null),
          resolveDormantCandidateBySubject: async () => null,
        },
      }),
    );
    assert.deepEqual(await f276.resolve({ ownerUserId, phrase: 'Alden' }), {
      kind: 'pending_candidate',
      producerId: 'F276',
      proposalId: 'person_candidate_alden',
    });
  });

  it('resolves exact F260 rejected and F276 suppression as producer-owned dormant state', async () => {
    const { ProactiveCandidateRegistryResolver } = await import(
      '../../dist/domains/memory/ProactiveCandidateRegistryResolver.js'
    );
    const f260 = new ProactiveCandidateRegistryResolver(
      deps({
        entityProposalStore: {
          listPending: () => [],
          listSettledByUser: () => [
            entityProposal({
              proposalId: 'entity-proposal-rejected',
              status: 'rejected',
            }),
          ],
        },
      }),
    );
    assert.deepEqual(await f260.resolve({ ownerUserId, phrase: 'Alden' }), {
      kind: 'dormant_candidate',
      producerId: 'F260',
      proposalId: 'entity-proposal-rejected',
    });

    const f276 = new ProactiveCandidateRegistryResolver(
      deps({
        personMemoryStore: {
          resolveActivePersonByAlias: async () => ({ status: 'not_available' }),
          resolvePendingCandidateBySubject: async () => null,
          resolveDormantCandidateBySubject: async () => ({
            candidateId: 'person_candidate_rejected',
          }),
        },
      }),
    );
    assert.deepEqual(await f276.resolve({ ownerUserId, phrase: 'Alden' }), {
      kind: 'dormant_candidate',
      producerId: 'F276',
      proposalId: 'person_candidate_rejected',
    });
  });

  it('returns unregistered only after every producer is an exact miss and fails closed on unknown reads', async () => {
    const { ProactiveCandidateRegistryResolver } = await import(
      '../../dist/domains/memory/ProactiveCandidateRegistryResolver.js'
    );
    const clear = new ProactiveCandidateRegistryResolver(deps());
    assert.deepEqual(await clear.resolve({ ownerUserId, phrase: 'Alden' }), {
      kind: 'unregistered',
    });

    const unavailable = new ProactiveCandidateRegistryResolver(
      deps({
        entityProposalStore: {
          listPending: () => {
            throw new Error('producer unavailable');
          },
          listSettledByUser: () => [],
        },
      }),
    );
    assert.deepEqual(await unavailable.resolve({ ownerUserId, phrase: 'Alden' }), {
      kind: 'unknown',
    });

    const ambiguousPerson = new ProactiveCandidateRegistryResolver(
      deps({
        personMemoryStore: {
          resolveActivePersonByAlias: async () => ({
            status: 'ambiguous',
            people: [{ personId: 'person_alden_1' }, { personId: 'person_alden_2' }],
          }),
          resolvePendingCandidateBySubject: async () => null,
          resolveDormantCandidateBySubject: async () => null,
        },
      }),
    );
    assert.deepEqual(await ambiguousPerson.resolve({ ownerUserId, phrase: 'Alden' }), {
      kind: 'unknown',
    });
  });
});
