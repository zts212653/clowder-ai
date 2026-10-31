import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { OwnerMemoryActionService } from '../dist/domains/memory/people/OwnerMemoryActionService.js';
import {
  personAggregateOwnerRevision,
  personClaimOwnerRevision,
  personInteractionOwnerRevision,
} from '../dist/domains/memory/people/person-memory-owner-revision.js';

const ownerUserId = 'owner-1';
const sourceRef = { kind: 'message', threadId: 'thread-owner-action', messageId: 'message-owner-action' };
const authority = {
  kind: 'card_approval',
  candidateId: 'person_candidate_owner_action_service',
  draftId: 'person_draft_owner_action_service',
  authorizedAt: 100,
};
const person = {
  personId: 'person_owner_action_service',
  ownerUserId,
  displayName: '黄挺',
  privateAliases: ['黄挺'],
  status: 'active',
  materializedBy: authority,
  createdAt: 100,
  sourceRefs: [sourceRef],
};
const claim = {
  claimId: 'person_claim_owner_action_service',
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
  relationshipId: 'relationship_owner_action_service',
  ownerUserId,
  personId: person.personId,
  status: 'current',
  materializedBy: authority,
  createdAt: 100,
  sourceRefs: [sourceRef],
  transitions: [{ status: 'current', recordedAt: 100, materializedBy: authority, sourceRefs: [sourceRef] }],
};
const event = {
  eventId: 'person_event_owner_action_service',
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
  content: '黄挺在终端用户计算开发部',
  timestamp: 90,
  deliveryStatus: 'delivered',
};
const context = {
  ownerUserId,
  sessionBindingId: 'browser-session-owner-action-service',
  csrfToken: 'csrf-owner-action-service',
};

describe('OwnerMemoryActionService source and revision guards', () => {
  let calls;
  let message;
  let replay;
  let store;
  let service;

  beforeEach(() => {
    calls = [];
    message = sourceMessage;
    replay = { outcome: 'none' };
    store = {
      getPerson: async (owner, personId) => (owner === ownerUserId && personId === person.personId ? person : null),
      listClaims: async () => [claim],
      listRelationships: async () => [relationship],
      listInteractionEvents: async () => [event],
      resolveOwnerActionReplay: async () => replay,
      executeOwnerAction: async (input) => {
        calls.push(input);
        return { action: input.command.action, outcome: 'applied' };
      },
    };
    service = new OwnerMemoryActionService({
      store,
      messageStore: { getById: async () => message },
      threadStore: {
        get: async () => ({ id: sourceRef.threadId, createdBy: ownerUserId, title: '人物来源' }),
        list: async () => [],
      },
      now: () => 500,
    });
  });

  function correctCommand(overrides = {}) {
    return {
      action: 'correct_claim',
      personId: person.personId,
      requestId: 'owner_action_service_correct',
      claimId: claim.claimId,
      expectedRevision: personClaimOwnerRevision(claim),
      payload: { ...claim.payload, value: '云计算产品部' },
      ...overrides,
    };
  }

  it('rejects stale item revisions before issuing evidence or executing a mutation', async () => {
    const result = await service.execute(context, correctCommand({ expectedRevision: `sha256:${'0'.repeat(64)}` }));
    assert.deepEqual(result, { action: 'correct_claim', outcome: 'stale_revision' });
    assert.equal(calls.length, 0);
  });

  it('requires a currently revalidated source for fact-changing claim and event actions', async () => {
    message = null;
    assert.deepEqual(await service.execute(context, correctCommand()), {
      action: 'correct_claim',
      outcome: 'source_unavailable',
    });
    const amend = {
      action: 'amend_event',
      personId: person.personId,
      requestId: 'owner_action_service_amend',
      eventId: event.eventId,
      expectedRevision: personInteractionOwnerRevision(event),
      payload: {
        eventKind: 'meeting',
        headline: '线上复盘',
        importanceOrTopic: '项目复盘',
        uncertaintyNotes: [],
      },
    };
    assert.deepEqual(await service.execute(context, amend), {
      action: 'amend_event',
      outcome: 'source_unavailable',
    });
    assert.equal(calls.length, 0);
  });

  it('allows only monotonic retire/forget when the prior source has disappeared', async () => {
    message = null;
    const retire = {
      action: 'retire_claim',
      personId: person.personId,
      requestId: 'owner_action_service_retire',
      claimId: claim.claimId,
      expectedRevision: personClaimOwnerRevision(claim),
    };
    assert.equal((await service.execute(context, retire)).outcome, 'applied');
    const forget = {
      action: 'hard_forget_person',
      personId: person.personId,
      requestId: 'person_forget_owner_action_service',
      expectedPersonRevision: personAggregateOwnerRevision({
        person,
        claims: [claim],
        relationships: [relationship],
        events: [event],
      }),
      confirmed: true,
    };
    assert.equal((await service.execute(context, forget)).outcome, 'applied');
    assert.equal(calls.length, 2);
    assert.ok(calls.every((call) => call.evidence.sourceState === 'unavailable_erasure_only'));
  });

  it('resolves an exact replay before target/source lookup but rejects a changed request digest', async () => {
    store.getPerson = async () => {
      throw new Error('target lookup must not run for replay');
    };
    replay = {
      outcome: 'replayed',
      result: { action: 'correct_claim', outcome: 'replayed', itemId: 'person_claim_replayed' },
    };
    assert.equal((await service.execute(context, correctCommand())).outcome, 'replayed');
    replay = { outcome: 'idempotency_conflict' };
    assert.deepEqual(await service.execute(context, correctCommand()), {
      action: 'correct_claim',
      outcome: 'idempotency_conflict',
    });
    assert.equal(calls.length, 0);
  });

  it('normalizes missing and foreign-owner targets to not_available', async () => {
    store.getPerson = async () => ({ ...person, ownerUserId: 'other-owner' });
    assert.deepEqual(await service.execute(context, correctCommand()), {
      action: 'correct_claim',
      outcome: 'not_available',
    });
    assert.equal(calls.length, 0);
  });
});
