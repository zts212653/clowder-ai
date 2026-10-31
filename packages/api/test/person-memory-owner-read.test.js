import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import Fastify from 'fastify';
import {
  OwnerMemoryActionEvidenceIssuer,
  ownerActionRequestDigest,
} from '../dist/domains/memory/people/OwnerMemoryActionEvidenceIssuer.js';
import { ownerMessageTextDigestMaterial } from '../dist/domains/memory/people/owner-message-text-projection.js';
import { PersonMemoryOwnerReadService } from '../dist/domains/memory/people/PersonMemoryOwnerReadService.js';
import { digestPersonMemorySourceMaterial } from '../dist/domains/memory/people/PersonMemorySourceBundleResolver.js';
import { RedisPersonMemoryStore } from '../dist/domains/memory/people/RedisPersonMemoryStore.js';
import { personMemoryOwnerReadRoutes } from '../dist/routes/person-memory-owner-read.js';

const ownerUserId = 'owner-1';
const sourceRef = { kind: 'message', threadId: 'thread-people', messageId: 'message-people' };
const authority = {
  kind: 'card_approval',
  candidateId: 'person_candidate_owner_read',
  draftId: 'person_draft_owner_read',
  authorizedAt: 100,
};
const sourceMessage = {
  id: sourceRef.messageId,
  threadId: sourceRef.threadId,
  userId: ownerUserId,
  catId: null,
  content: '黄挺在终端用户计算开发部，原始 prompt 不应该出现在读取接口。',
  timestamp: 90,
  deliveryStatus: 'delivered',
};

function resolvedSource() {
  return {
    sourceId: 'owner-source',
    kind: 'message_text',
    sourceRef,
    ownerUserId,
    resolvedDigest: digestPersonMemorySourceMaterial(ownerMessageTextDigestMaterial(sourceMessage)),
    excerpt: '黄挺在终端用户计算开发部',
  };
}

function typedProvenance(target) {
  return {
    sources: [resolvedSource()],
    assertionBindings: [{ sourceId: 'owner-source', target, role: 'reported_fact' }],
  };
}

const person = {
  personId: 'person_owner_read',
  ownerUserId,
  displayName: '黄挺',
  privateAliases: ['黄挺', 'ting.huang'],
  status: 'active',
  materializedBy: authority,
  createdAt: 100,
  sourceRefs: [sourceRef],
  typedProvenance: typedProvenance({ kind: 'claim', draftId: 'person_draft_owner_read' }),
};
const claim = {
  claimId: 'person_claim_owner_read',
  personId: person.personId,
  ownerUserId,
  payload: {
    kind: 'reported_fact',
    predicate: 'organization_unit',
    value: '终端用户计算开发部',
    assertedBy: 'owner',
  },
  status: 'current',
  recordedAt: 110,
  sourceRefs: [sourceRef],
  typedProvenance: typedProvenance({ kind: 'claim', draftId: 'person_draft_owner_read' }),
  materializedBy: authority,
};
const relationship = {
  relationshipId: 'relationship_owner_read',
  ownerUserId,
  personId: person.personId,
  status: 'current',
  materializedBy: authority,
  createdAt: 100,
  sourceRefs: [sourceRef],
  typedProvenance: typedProvenance({
    kind: 'relationship',
    draftId: 'person_draft_owner_read',
    field: 'status',
  }),
  transitions: [
    {
      status: 'current',
      recordedAt: 100,
      materializedBy: authority,
      sourceRefs: [sourceRef],
      typedProvenance: typedProvenance({
        kind: 'relationship',
        draftId: 'person_draft_owner_read',
        field: 'status',
      }),
    },
  ],
};
const event = {
  eventId: 'person_event_owner_read',
  relationshipId: relationship.relationshipId,
  ownerUserId,
  occurredAt: { kind: 'approximate', raw: '上周', qualifier: 'about' },
  recordedAt: 120,
  eventKind: 'meeting',
  headline: '线下见面',
  importanceOrTopic: '项目协作',
  uncertaintyNotes: [],
  sourceRefs: [sourceRef],
  typedProvenance: typedProvenance({
    kind: 'interaction',
    draftId: 'person_draft_owner_read',
    field: 'headline',
  }),
  materializedBy: authority,
  status: 'active',
};

function fakeStore(overrides = {}) {
  return {
    listPeople: async (owner) => (owner === ownerUserId ? [person] : []),
    getPerson: async (owner, personId) => (owner === ownerUserId && personId === person.personId ? person : null),
    listClaims: async () => [claim],
    listRelationships: async () => [relationship],
    listInteractionEvents: async () => [event],
    listCandidateIdsForPerson: async () => [],
    getCandidateForOwner: async () => null,
    ...overrides,
  };
}

describe('F276 owner person-memory reads', () => {
  let app;
  let messages;
  let store;
  let threads;

  beforeEach(async () => {
    messages = new Map([[sourceMessage.id, { ...sourceMessage }]]);
    threads = new Map([
      [sourceRef.threadId, { id: sourceRef.threadId, createdBy: ownerUserId, title: '人物来源对话' }],
    ]);
    store = fakeStore();
    app = Fastify();
    app.addHook('preHandler', async (request) => {
      request.sessionUserId = request.headers['x-test-session'];
    });
    await app.register(personMemoryOwnerReadRoutes, {
      ownerUserId,
      store,
      messageStore: { getById: async (messageId) => messages.get(messageId) ?? null },
      threadStore: {
        get: async (threadId) => threads.get(threadId) ?? null,
        list: async () => [...threads.values()],
      },
    });
    app.get('/api/unrelated-read', async () => ({ ok: true }));
    await app.ready();
  });

  const get = (url, session = ownerUserId) =>
    app.inject({ method: 'GET', url, headers: session ? { 'x-test-session': session } : {} });

  it('requires the authenticated owner session and ignores identity headers', async () => {
    assert.equal((await get('/api/memory/people', null)).statusCode, 401);
    assert.equal(
      (
        await app.inject({
          method: 'GET',
          url: '/api/memory/people',
          headers: { 'x-cat-cafe-user': ownerUserId },
        })
      ).statusCode,
      401,
    );
    assert.equal((await get('/api/memory/people', 'other-owner')).statusCode, 403);
    assert.equal((await get('/api/memory/people?ownerUserId=other-owner')).statusCode, 400);
    assert.equal((await app.inject({ url: '/api/unrelated-read' })).statusCode, 200);
  });

  it('lists bounded owner people without proposal, provenance, or prompt payloads', async () => {
    const response = await get('/api/memory/people?limit=20&offset=0');
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), {
      readStatus: 'ready',
      entries: [
        {
          personId: person.personId,
          displayName: '黄挺',
          aliases: ['黄挺', 'ting.huang'],
          status: 'active',
          createdAt: 100,
          updatedAt: 120,
          currentClaimCount: 1,
          activeInteractionCount: 1,
          relationship: { relationshipId: relationship.relationshipId, status: 'current', recordedAt: 100 },
          latestInteraction: {
            eventId: event.eventId,
            eventKind: 'meeting',
            headline: '线下见面',
            occurredAt: event.occurredAt,
            recordedAt: 120,
          },
        },
      ],
      meta: { count: 1, limit: 20, offset: 0, hasMore: false },
    });
    assert.equal(response.body.includes('原始 prompt'), false);
    assert.equal(response.body.includes('typedProvenance'), false);
    assert.equal(response.body.includes('person_candidate_'), false);
    assert.equal(response.body.includes('ownerUserId'), false);
  });

  it('returns a lifecycle detail projection and fails closed on an inconsistent owner record', async () => {
    const response = await get(`/api/memory/people/${person.personId}`);
    assert.equal(response.statusCode, 200);
    const detail = response.json();
    assert.equal(detail.personId, person.personId);
    assert.equal(detail.claims[0].payload.value, '终端用户计算开发部');
    assert.equal(detail.relationships[0].status, 'current');
    assert.equal(detail.interactions[0].headline, '线下见面');
    assert.equal(detail.claims[0].sourceCount, 1);
    assert.equal(detail.interactions[0].sourceCount, 1);
    assert.equal(response.body.includes('原始 prompt'), false);
    assert.equal(response.body.includes('typedProvenance'), false);
    assert.equal(response.body.includes('materializedBy'), false);

    store.getPerson = async () => ({ ...person, ownerUserId: 'other-owner' });
    assert.equal((await get(`/api/memory/people/${person.personId}`)).statusCode, 404);
  });

  it('revalidates exact F276 provenance and returns navigation coordinates without source text', async () => {
    const url = `/api/memory/people/${person.personId}/source?kind=claim&itemId=${claim.claimId}`;
    const ready = await get(url);
    assert.equal(ready.statusCode, 200);
    assert.deepEqual(ready.json(), {
      status: 'ready',
      sources: [
        {
          kind: 'message',
          threadId: sourceRef.threadId,
          messageId: sourceRef.messageId,
          title: '人物来源对话',
          canOpen: true,
        },
      ],
    });
    assert.equal(ready.body.includes(sourceMessage.content), false);
    assert.equal(ready.body.includes('excerpt'), false);

    messages.set(sourceMessage.id, { ...sourceMessage, content: `${sourceMessage.content}（已编辑）` });
    assert.deepEqual((await get(url)).json(), { status: 'unavailable', sources: [] });
    messages.set(sourceMessage.id, { ...sourceMessage, userId: 'other-owner' });
    assert.deepEqual((await get(url)).json(), { status: 'unavailable', sources: [] });
    messages.set(sourceMessage.id, sourceMessage);
    threads.set(sourceRef.threadId, { ...threads.get(sourceRef.threadId), createdBy: 'other-owner' });
    assert.deepEqual((await get(url)).json(), { status: 'unavailable', sources: [] });
  });

  it('does not reveal whether a foreign or unknown person exists', async () => {
    for (const suffix of ['', '/source?kind=person']) {
      const response = await get(`/api/memory/people/person_foreign${suffix}`);
      assert.equal(response.statusCode, 404);
      assert.deepEqual(response.json(), { error: 'not_available' });
    }
  });

  it('returns an explicit unavailable state when the canonical store is offline', async () => {
    const offline = Fastify();
    offline.addHook('preHandler', async (request) => {
      request.sessionUserId = ownerUserId;
    });
    await offline.register(personMemoryOwnerReadRoutes, {
      ownerUserId,
      store: null,
      messageStore: { getById: async () => null },
      threadStore: { get: async () => null, list: async () => [] },
    });
    await offline.ready();
    const response = await offline.inject({ method: 'GET', url: '/api/memory/people' });
    assert.equal(response.statusCode, 503);
    assert.deepEqual(response.json(), { readStatus: 'unavailable', entries: [], error: 'Person memory unavailable' });
    await offline.close();
  });
});

describe('RedisPersonMemoryStore.listPeople', () => {
  it('discovers canonical owner people independently of proposal lifecycle indexes', async () => {
    const values = new Map([
      [`person-memory:person:${ownerUserId}:${person.personId}`, JSON.stringify(person)],
      [
        `person-memory:person:${ownerUserId}:person_foreign`,
        JSON.stringify({ ...person, personId: 'person_foreign', ownerUserId: 'other-owner' }),
      ],
      [`person-memory:person:other-owner:person_other`, JSON.stringify({ ...person, personId: 'person_other' })],
    ]);
    const redis = {
      options: { keyPrefix: '' },
      scan: async () => [
        '0',
        [...values.keys()].filter((key) => key.startsWith(`person-memory:person:${ownerUserId}:`)),
      ],
      mget: async (...keys) => keys.map((key) => values.get(key) ?? null),
    };
    const store = new RedisPersonMemoryStore(redis);
    assert.deepEqual(await store.listPeople(ownerUserId), [person]);
  });

  it('escapes owner metacharacters before using a Redis SCAN pattern', async () => {
    const metacharacterOwner = 'owner-*';
    const storedPerson = { ...person, ownerUserId: metacharacterOwner };
    const logicalKey = `person-memory:person:${metacharacterOwner}:${storedPerson.personId}`;
    let observedPattern;
    const redis = {
      options: { keyPrefix: 'cat-cafe:' },
      scan: async (_cursor, _match, pattern) => {
        observedPattern = pattern;
        return ['0', [`cat-cafe:${logicalKey}`]];
      },
      mget: async (...keys) => keys.map((key) => (key === logicalKey ? JSON.stringify(storedPerson) : null)),
    };

    assert.deepEqual(await new RedisPersonMemoryStore(redis).listPeople(metacharacterOwner), [storedPerson]);
    assert.equal(observedPattern, 'cat-cafe:person-memory:person:owner-\\*:*');
  });
});

describe('PersonMemoryOwnerReadService source selector', () => {
  it('rejects an item that does not belong to the requested person', async () => {
    const service = new PersonMemoryOwnerReadService({
      store: fakeStore({ listClaims: async () => [{ ...claim, personId: 'person_other' }] }),
      messageStore: { getById: async () => sourceMessage },
      threadStore: { get: async () => null, list: async () => [] },
    });
    assert.deepEqual(await service.readSource(ownerUserId, person.personId, { kind: 'claim', itemId: claim.claimId }), {
      status: 'not_available',
    });
  });

  it('projects verified owner-action evidence without leaking target, session, CSRF, or action IDs', async () => {
    const command = {
      action: 'correct_claim',
      personId: person.personId,
      requestId: 'owner_action_source_projection',
      claimId: claim.claimId,
      expectedRevision: `sha256:${'a'.repeat(64)}`,
      payload: { ...claim.payload, value: '云计算产品部' },
    };
    const requestDigest = ownerActionRequestDigest(ownerUserId, command);
    const evidence = new OwnerMemoryActionEvidenceIssuer().issue({
      ownerUserId,
      sessionBindingId: 'private-browser-session-binding',
      csrfToken: 'private-csrf-token',
      command,
      requestDigest,
      sourceState: 'live',
      issuedAt: 1_760_000_000_000,
    });
    const actionClaim = {
      ...claim,
      payload: command.payload,
      sourceRefs: [],
      typedProvenance: undefined,
      materializedBy: evidence,
    };
    const service = new PersonMemoryOwnerReadService({
      store: fakeStore({ listClaims: async () => [actionClaim] }),
      messageStore: { getById: async () => null },
      threadStore: { get: async () => null, list: async () => [] },
    });
    const detail = await service.readDetail(ownerUserId, person.personId);
    assert.equal(detail.detail.claims[0].sourceCount, 1);
    const source = await service.readSource(ownerUserId, person.personId, {
      kind: 'claim',
      itemId: claim.claimId,
    });
    assert.deepEqual(source, {
      status: 'ready',
      sources: [
        {
          kind: 'owner_action',
          label: '主人在记忆页操作 · 修改 · 2025-10-09T08:53:20.000Z',
          occurredAt: 1_760_000_000_000,
          canOpen: false,
        },
      ],
    });
    const serialized = JSON.stringify(source);
    for (const secret of [
      evidence.actionId,
      evidence.sessionBindingDigest,
      evidence.csrfVerificationDigest,
      evidence.target.itemId,
      evidence.requestDigest,
    ]) {
      assert.equal(serialized.includes(secret), false);
    }
  });
});
