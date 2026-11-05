import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import cookie from '@fastify/cookie';
import Fastify from 'fastify';
import { sessionAuthPlugin, sessionRoute } from '../dist/infrastructure/session-auth.js';
import { personMemoryOwnerReadRoutes } from '../dist/routes/person-memory-owner-read.js';

const ownerUserId = 'owner-1';
const allowedOrigin = 'http://localhost:3003';
const sourceRef = { kind: 'message', threadId: 'thread-people', messageId: 'message-people' };
const authority = {
  kind: 'card_approval',
  candidateId: 'person_candidate_owner_mutation',
  draftId: 'person_draft_owner_mutation',
  authorizedAt: 100,
};
const person = {
  personId: 'person_owner_mutation',
  ownerUserId,
  displayName: '黄挺',
  privateAliases: ['黄挺'],
  status: 'active',
  materializedBy: authority,
  createdAt: 100,
  sourceRefs: [sourceRef],
};
const claim = {
  claimId: 'person_claim_owner_mutation',
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
  materializedBy: authority,
};
const relationship = {
  relationshipId: 'relationship_owner_mutation',
  ownerUserId,
  personId: person.personId,
  status: 'current',
  materializedBy: authority,
  createdAt: 100,
  sourceRefs: [sourceRef],
  transitions: [{ status: 'current', recordedAt: 100, materializedBy: authority, sourceRefs: [sourceRef] }],
};
const event = {
  eventId: 'person_event_owner_mutation',
  relationshipId: relationship.relationshipId,
  ownerUserId,
  recordedAt: 120,
  eventKind: 'meeting',
  headline: '线下见面',
  importanceOrTopic: '项目协作',
  uncertaintyNotes: [],
  sourceRefs: [sourceRef],
  materializedBy: authority,
  status: 'active',
};
const sourceMessage = {
  id: sourceRef.messageId,
  threadId: sourceRef.threadId,
  userId: ownerUserId,
  catId: null,
  content: '黄挺在终端用户计算开发部。',
  timestamp: 90,
  deliveryStatus: 'delivered',
};

function fakeStore(mutationCalls) {
  return {
    listPeople: async () => [person],
    getPerson: async (owner, personId) => (owner === ownerUserId && personId === person.personId ? person : null),
    listClaims: async () => [claim],
    listRelationships: async () => [relationship],
    listInteractionEvents: async () => [event],
    listCandidateIdsForPerson: async () => [],
    getCandidateForOwner: async () => null,
    resolveOwnerActionReplay: async () => ({ outcome: 'none' }),
    executeOwnerAction: async (input) => {
      mutationCalls.push(input);
      if (input.command.action === 'hard_forget_person') {
        return {
          outcome: 'applied',
          action: input.command.action,
          receipt: {
            requestId: input.command.requestId,
            ownerUserId,
            completedAt: input.evidence.issuedAt,
            purgedSurfaceCounts: { artifacts: 4 },
            verdict: 'purged',
          },
        };
      }
      return { outcome: 'applied', action: input.command.action };
    },
  };
}

function cookieHeader(response) {
  const raw = response.headers['set-cookie'];
  assert.ok(raw, 'session bootstrap must issue a cookie');
  return raw.split(';', 1)[0];
}

function actionCommands(detail) {
  return [
    {
      action: 'correct_claim',
      requestId: 'owner_action_correct_0123456789abcdef',
      claimId: claim.claimId,
      expectedRevision: detail.claims[0].revision,
      payload: { ...claim.payload, value: '云计算产品部' },
    },
    {
      action: 'retire_claim',
      requestId: 'owner_action_retire_0123456789abcdef',
      claimId: claim.claimId,
      expectedRevision: detail.claims[0].revision,
    },
    {
      action: 'amend_event',
      requestId: 'owner_action_amend_0123456789abcdef',
      eventId: event.eventId,
      expectedRevision: detail.interactions[0].revision,
      payload: {
        eventKind: 'meeting',
        headline: '线上复盘',
        importanceOrTopic: '项目复盘',
        uncertaintyNotes: [],
      },
    },
    {
      action: 'hard_forget_person',
      requestId: 'person_forget_owner_action_0123456789abcdef',
      expectedPersonRevision: detail.personRevision,
      confirmed: true,
    },
  ];
}

describe('F276 owner browser mutation routes', () => {
  let app;
  let mutationCalls;
  let session;
  let currentSourceMessage;

  beforeEach(async () => {
    mutationCalls = [];
    currentSourceMessage = sourceMessage;
    app = Fastify();
    await app.register(cookie);
    await app.register(sessionAuthPlugin);
    await app.register(sessionRoute, { ownerUserId });
    await app.register(personMemoryOwnerReadRoutes, {
      ownerUserId,
      store: fakeStore(mutationCalls),
      messageStore: { getById: async (id) => (id === sourceMessage.id ? currentSourceMessage : null) },
      threadStore: {
        get: async (id) =>
          id === sourceRef.threadId
            ? { id, title: '人物来源对话', createdBy: ownerUserId, visibility: 'private' }
            : null,
        list: async () => [],
      },
    });
    await app.ready();

    const login = await app.inject({ method: 'GET', url: '/api/session', headers: { origin: allowedOrigin } });
    assert.equal(login.statusCode, 200);
    session = {
      cookie: cookieHeader(login),
      csrfToken: login.json().csrfToken,
    };
    assert.match(session.csrfToken, /^[A-Za-z0-9_-]{32,}$/);
  });

  afterEach(async () => {
    await app?.close();
  });

  async function detail() {
    const response = await app.inject({
      method: 'GET',
      url: `/api/memory/people/${person.personId}`,
      headers: { cookie: session.cookie },
    });
    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.match(body.personRevision, /^sha256:[a-f0-9]{64}$/);
    assert.match(body.claims[0].revision, /^sha256:[a-f0-9]{64}$/);
    assert.match(body.interactions[0].revision, /^sha256:[a-f0-9]{64}$/);
    return body;
  }

  async function post(command, extraHeaders = {}) {
    return app.inject({
      method: 'POST',
      url: `/api/memory/people/${person.personId}/actions`,
      headers: {
        cookie: session.cookie,
        origin: allowedOrigin,
        'x-csrf-token': session.csrfToken,
        'content-type': 'application/json',
        ...extraHeaders,
      },
      payload: command,
    });
  }

  it('publishes opaque revisions and accepts all four actions only from the browser session + CSRF path', async () => {
    const commands = actionCommands(await detail());
    for (const command of commands) {
      const response = await post(command);
      assert.equal(response.statusCode, 200, `${command.action}: ${response.body}`);
      assert.equal(response.json().action, command.action);
    }
    assert.equal(mutationCalls.length, 4);
    assert.ok(mutationCalls.every((call) => call.evidence.kind === 'owner_memory_action'));
  });

  it('rejects cat callback credentials for every action even when a valid owner cookie is also present', async () => {
    const commands = actionCommands(await detail());
    for (const command of commands) {
      const response = await post(command, {
        'x-invocation-id': 'inv-cat-cannot-click',
        'x-callback-token': 'callback-cat-cannot-click',
      });
      assert.equal(response.statusCode, 403, `${command.action}: ${response.body}`);
    }
    assert.equal(mutationCalls.length, 0);
  });

  it('rejects agent-key, identity-header, internal-service, missing-CSRF and cross-origin attempts with zero effects', async () => {
    const commands = actionCommands(await detail());
    for (const headers of [
      { 'x-agent-key-secret': 'agent-key-cannot-click' },
      { 'x-cat-cafe-user': ownerUserId },
      { authorization: ['Be', 'arer internal-service-cannot-click'].join('') },
      { 'x-csrf-token': 'wrong-token' },
      { origin: 'https://evil.example' },
    ]) {
      for (const command of commands) {
        const response = await post(command, headers);
        assert.equal(response.statusCode, 403, `${command.action}: ${response.body}`);
      }
    }
    assert.equal(mutationCalls.length, 0);
  });

  it('rejects unauthenticated requests and caller-shaped owner/source coordinates before mutation', async () => {
    const [command] = actionCommands(await detail());
    const noSession = await app.inject({
      method: 'POST',
      url: `/api/memory/people/${person.personId}/actions`,
      headers: {
        origin: allowedOrigin,
        'x-csrf-token': session.csrfToken,
        'content-type': 'application/json',
      },
      payload: command,
    });
    assert.equal(noSession.statusCode, 401);
    for (const smuggled of [
      { ownerUserId },
      { sourceRef },
      { threadId: sourceRef.threadId, messageId: sourceRef.messageId },
      { evidence: { kind: 'owner_memory_action' } },
    ]) {
      const response = await post({ ...command, ...smuggled });
      assert.equal(response.statusCode, 400, response.body);
    }
    assert.equal((await post({ ...command, requestId: 'predictable' })).statusCode, 400);
    assert.equal(mutationCalls.length, 0);
  });

  it('maps stale revisions and source loss without writing, while monotonic erasure remains available', async () => {
    const commands = actionCommands(await detail());
    const stale = await post({ ...commands[0], expectedRevision: `sha256:${'0'.repeat(64)}` });
    assert.equal(stale.statusCode, 409);
    assert.deepEqual(stale.json(), { error: 'stale_revision' });

    currentSourceMessage = null;
    for (const command of [commands[0], commands[2]]) {
      const response = await post(command);
      assert.equal(response.statusCode, 409, `${command.action}: ${response.body}`);
      assert.deepEqual(response.json(), { error: 'source_unavailable' });
    }
    for (const command of [commands[1], commands[3]]) {
      const response = await post(command);
      assert.equal(response.statusCode, 200, `${command.action}: ${response.body}`);
    }
    assert.equal(mutationCalls.length, 2);
    assert.ok(mutationCalls.every((call) => call.evidence.sourceState === 'unavailable_erasure_only'));
  });
});
