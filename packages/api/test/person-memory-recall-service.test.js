import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PersonMemoryRecallService } from '../dist/domains/memory/people/PersonMemoryRecallService.js';

const sourceRef = { kind: 'message', threadId: 'thread_people', messageId: 'message_people' };
const authority = {
  kind: 'card_approval',
  candidateId: 'person_candidate_recall',
  draftId: 'person_draft_recall',
  authorizedAt: 100,
};
const person = {
  personId: 'person_recall',
  ownerUserId: 'owner-1',
  displayName: '黄挺',
  privateAliases: ['黄挺'],
  status: 'active',
  materializedBy: authority,
  createdAt: 100,
  sourceRefs: [sourceRef],
};
const relationship = {
  relationshipId: 'relationship_recall',
  ownerUserId: 'owner-1',
  personId: person.personId,
  status: 'current',
  materializedBy: authority,
  createdAt: 100,
  sourceRefs: [sourceRef],
  transitions: [{ status: 'current', recordedAt: 100, materializedBy: authority, sourceRefs: [sourceRef] }],
};
const claim = {
  claimId: 'person_claim_recall',
  personId: person.personId,
  ownerUserId: 'owner-1',
  payload: {
    kind: 'reported_fact',
    predicate: 'organization_unit',
    value: '终端用户计算开发部',
    assertedBy: 'owner',
  },
  status: 'current',
  recordedAt: 100,
  sourceRefs: [sourceRef],
  materializedBy: authority,
};
const event = {
  eventId: 'person_event_recall',
  relationshipId: relationship.relationshipId,
  ownerUserId: 'owner-1',
  occurredAt: { kind: 'approximate', raw: '11 点多', qualifier: 'about' },
  recordedAt: 120,
  eventKind: 'meeting',
  headline: '线下见面',
  sourceRefs: [sourceRef],
  materializedBy: authority,
  status: 'active',
};

function fakeStore(overrides = {}) {
  return {
    resolveActivePersonByAlias: async (owner, alias) =>
      owner === 'owner-1' && alias === '黄挺' ? { status: 'resolved', person } : { status: 'not_available' },
    resolveActivePersonByWorkspaceEntityRef: async () => ({ status: 'not_available' }),
    getPerson: async (owner, personId) => (owner === 'owner-1' && personId === person.personId ? person : null),
    listClaims: async () => [claim],
    listRelationships: async () => [relationship],
    listInteractionEvents: async () => [event],
    ...overrides,
  };
}

function workspaceResolver(overrides = {}) {
  return {
    resolve: async () => ({ status: 'not_found' }),
    ...overrides,
  };
}

describe('PersonMemoryRecallService', () => {
  it('builds only an authorized bounded derived relationship card', async () => {
    const service = new PersonMemoryRecallService(fakeStore(), workspaceResolver());
    const result = await service.recallByAlias('owner-1', '黄挺');
    assert.equal(result.status, 'resolved');
    assert.equal(result.card.storable, false);
    assert.equal(result.card.indexable, false);
    assert.equal(result.card.facts.length, 1);
    assert.equal(result.card.latestInteraction.headline, '线下见面');
    assert.ok(result.card.estimatedTokens <= 160);
    assert.equal(JSON.stringify(result).includes('candidate'), false);
    assert.deepEqual(await service.recallByAlias('other-owner', '黄挺'), { status: 'not_available' });
  });

  it('fails closed on same-name ambiguity without choosing a dossier', async () => {
    const second = { ...person, personId: 'person_recall_2' };
    const service = new PersonMemoryRecallService(
      fakeStore({
        resolveActivePersonByAlias: async () => ({ status: 'ambiguous', people: [person, second] }),
      }),
      workspaceResolver(),
    );
    const result = await service.recallByAlias('owner-1', '黄挺');
    assert.deepEqual(result, {
      status: 'ambiguous',
      candidates: [
        { personId: person.personId, displayName: '黄挺' },
        { personId: second.personId, displayName: '黄挺' },
      ],
    });
  });

  it('recalls an owner-private extension from a workspace Entity-only alias', async () => {
    const linkedPerson = {
      ...person,
      workspaceEntityLink: {
        entityRef: 'person:huang-ting-huawei',
        state: 'linked',
        checkedAt: 90,
      },
    };
    const service = new PersonMemoryRecallService(
      fakeStore({
        resolveActivePersonByAlias: async () => ({ status: 'not_available' }),
        resolveActivePersonByWorkspaceEntityRef: async (ownerUserId, entityRef) =>
          ownerUserId === 'owner-1' && entityRef === 'person:huang-ting-huawei'
            ? { status: 'resolved', person: linkedPerson }
            : { status: 'not_available' },
      }),
      workspaceResolver({
        resolve: async () => ({
          status: 'resolved',
          entityRef: 'person:huang-ting-huawei',
          canonicalName: '黄挺',
        }),
      }),
    );

    const result = await service.recallByAlias('owner-1', 'ting.huang');
    assert.equal(result.status, 'resolved');
    assert.equal(result.card.personId, linkedPerson.personId);
  });

  it('recalls directly from an exact workspace entity ref without alias selection', async () => {
    const service = new PersonMemoryRecallService(
      fakeStore({
        resolveActivePersonByAlias: async () => {
          throw new Error('alias resolver must not run');
        },
        resolveActivePersonByWorkspaceEntityRef: async (ownerUserId, entityRef) =>
          ownerUserId === 'owner-1' && entityRef === 'person:huang-ting-huawei'
            ? { status: 'resolved', person }
            : { status: 'not_available' },
      }),
      workspaceResolver(),
    );
    const result = await service.recallByWorkspaceEntityRef('owner-1', 'person:huang-ting-huawei');
    assert.equal(result.status, 'resolved');
    assert.equal(result.card.personId, person.personId);
    assert.deepEqual(await service.recallByWorkspaceEntityRef('owner-1', 'person:other'), {
      status: 'not_available',
    });
  });

  it('returns unavailable when an Entity has no private extension or paths disagree', async () => {
    const linkedPerson = {
      ...person,
      workspaceEntityLink: {
        entityRef: 'person:huang-ting-huawei',
        state: 'linked',
        checkedAt: 90,
      },
    };
    const resolvedWorkspace = workspaceResolver({
      resolve: async () => ({
        status: 'resolved',
        entityRef: 'person:huang-ting-huawei',
        canonicalName: '黄挺',
      }),
    });
    const withoutExtension = new PersonMemoryRecallService(
      fakeStore({
        resolveActivePersonByAlias: async () => ({ status: 'not_available' }),
      }),
      resolvedWorkspace,
    );
    assert.deepEqual(await withoutExtension.recallByAlias('owner-1', 'ting.huang'), {
      status: 'not_available',
    });

    const otherPerson = { ...person, personId: 'person_recall_other', displayName: '另一个黄挺' };
    const disagreement = new PersonMemoryRecallService(
      fakeStore({
        resolveActivePersonByAlias: async () => ({ status: 'resolved', person: otherPerson }),
        resolveActivePersonByWorkspaceEntityRef: async () => ({ status: 'resolved', person: linkedPerson }),
      }),
      resolvedWorkspace,
    );
    assert.deepEqual(await disagreement.recallByAlias('owner-1', '黄挺'), {
      status: 'not_available',
    });
  });

  it('fails closed when workspace identity resolution is ambiguous or unavailable', async () => {
    for (const status of ['ambiguous', 'unavailable']) {
      const service = new PersonMemoryRecallService(
        fakeStore(),
        workspaceResolver({ resolve: async () => ({ status }) }),
      );
      assert.deepEqual(await service.recallByAlias('owner-1', '黄挺'), {
        status: 'not_available',
      });
    }
  });

  it('requires an exact item and time window, then enforces per-person drill budget', async () => {
    const service = new PersonMemoryRecallService(fakeStore(), workspaceResolver());
    const request = {
      ownerUserId: 'owner-1',
      turnId: 'invocation-1',
      personId: person.personId,
      item: { kind: 'claim', id: claim.claimId },
      timeWindow: { from: 0, to: 1_000 },
    };
    for (let index = 0; index < 3; index += 1) {
      const result = await service.drill(request);
      assert.equal(result.status, 'ok');
      assert.equal(result.projection.sourceRef.messageId, sourceRef.messageId);
      assert.ok(result.estimatedTokens <= 500);
      assert.equal(Object.hasOwn(result.projection, 'sourceBody'), false);
    }
    assert.deepEqual(await service.drill(request), { status: 'budget_exceeded' });
    assert.deepEqual(await service.drill({ ...request, turnId: 'invocation-2', timeWindow: { from: 200, to: 300 } }), {
      status: 'not_available',
    });
  });
});
