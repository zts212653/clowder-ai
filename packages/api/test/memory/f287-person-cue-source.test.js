import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const currentMessage = {
  id: 'message-current',
  threadId: 'thread-current',
  userId: 'owner-1',
  catId: null,
  content: 'Alden is here',
  mentions: [],
  timestamp: 1_785_600_000_000,
};

const card = {
  personId: 'person-private-alden',
  displayName: 'Alden',
  facts: [
    {
      claimId: 'claim-1',
      text: 'Prefers exact evidence.',
      kind: 'reported_fact',
      provenanceRefs: [{ kind: 'message', threadId: 'thread-other', messageId: 'message-history' }],
    },
  ],
  relationshipId: 'relationship-1',
  uncertainty: [],
  provenanceRefs: [{ kind: 'message', threadId: 'thread-other', messageId: 'message-history' }],
  dossierRef: 'person-private-alden',
  estimatedTokens: 20,
  storable: false,
  indexable: false,
};

const historyMessage = {
  id: 'message-history',
  threadId: 'thread-other',
  userId: 'owner-1',
  catId: null,
  content: 'Owner-authored source',
  mentions: [],
  timestamp: 1_785_500_000_000,
};

describe('F287 person cue canonical source', () => {
  test('binds the exact workspace entity and drills owner-visible cross-thread history', async () => {
    const { PersonMemoryCueSource } = await import('../../dist/domains/memory/cue/sources/PersonMemoryCueSource.js');
    const calls = [];
    const recall = {
      async recallByWorkspaceEntityRef(ownerUserId, entityRef) {
        calls.push({ ownerUserId, entityRef });
        return ownerUserId === 'owner-1' && entityRef === 'person:alden'
          ? { status: 'resolved', card, asOf: 1_785_500_000_000 }
          : { status: 'not_available' };
      },
      async recallByPersonId(ownerUserId, personId) {
        return ownerUserId === 'owner-1' && personId === card.personId
          ? { status: 'resolved', card, asOf: 1_785_500_000_000 }
          : { status: 'not_available' };
      },
      async recallByAlias() {
        throw new Error('alias recall must not replace the typed entity binding');
      },
    };
    const source = new PersonMemoryCueSource({
      recall,
      messageStore: {
        getById: async (messageId) => (messageId === currentMessage.id ? currentMessage : historyMessage),
      },
    });

    const exact = await source.resolve({
      ownerUserId: 'owner-1',
      threadId: 'thread-current',
      entityId: 'person:alden',
      matchedAlias: 'Alden',
      sourceMessageId: 'message-current',
    });
    assert.equal(exact.anchor, 'person-memory:person-private-alden');
    assert.equal(exact.asOf, 1_785_500_000_000);
    assert.deepEqual(calls, [{ ownerUserId: 'owner-1', entityRef: 'person:alden' }]);
    const drilled = await source.read({
      ownerUserId: 'owner-1',
      anchor: exact.anchor,
      expectedRevision: exact.revision,
    });
    assert.equal(drilled.status, 'ok');
    assert.deepEqual(drilled.payload.provenanceRefs, [
      { kind: 'message', threadId: 'thread-other', messageId: 'message-history' },
    ]);
    assert.equal(drilled.payload.sourceRevision, exact.revision);
    assert.equal(drilled.payload.asOf, exact.asOf);
    assert.deepEqual(drilled.payload.drill, {
      family: 'person_memory',
      anchor: 'person-memory:person-private-alden',
    });

    assert.equal(
      await source.resolve({
        ownerUserId: 'owner-1',
        threadId: 'thread-current',
        entityId: 'person:same-name-other',
        matchedAlias: 'Alden',
        sourceMessageId: 'message-current',
      }),
      null,
    );
  });

  test('fails closed after correction, forget, or source ACL revocation', async () => {
    const { PersonMemoryCueSource } = await import('../../dist/domains/memory/cue/sources/PersonMemoryCueSource.js');
    let mode = 'fresh';
    const recall = {
      async recallByWorkspaceEntityRef() {
        return { status: 'resolved', card, asOf: 1_785_500_000_000 };
      },
      async recallByPersonId() {
        if (mode === 'forgotten') return { status: 'not_available' };
        if (mode === 'corrected') {
          return {
            status: 'resolved',
            card: { ...card, facts: [{ ...card.facts[0], text: 'Corrected fact.' }] },
            asOf: 1_785_600_000_000,
          };
        }
        return { status: 'resolved', card, asOf: 1_785_500_000_000 };
      },
    };
    const source = new PersonMemoryCueSource({
      recall,
      messageStore: {
        getById: async (messageId) => {
          if (messageId === currentMessage.id) return currentMessage;
          return mode === 'revoked' ? { ...historyMessage, visibility: 'whisper' } : historyMessage;
        },
      },
    });
    const exact = await source.resolve({
      ownerUserId: 'owner-1',
      threadId: 'thread-current',
      entityId: 'person:alden',
      matchedAlias: 'Alden',
      sourceMessageId: 'message-current',
    });

    mode = 'corrected';
    assert.deepEqual(
      await source.read({ ownerUserId: 'owner-1', anchor: exact.anchor, expectedRevision: exact.revision }),
      { status: 'not_available', invalidationReason: 'source_corrected' },
    );
    mode = 'forgotten';
    assert.deepEqual(
      await source.read({ ownerUserId: 'owner-1', anchor: exact.anchor, expectedRevision: exact.revision }),
      { status: 'not_available', invalidationReason: 'source_forgotten' },
    );
    mode = 'revoked';
    assert.deepEqual(
      await source.read({ ownerUserId: 'owner-1', anchor: exact.anchor, expectedRevision: exact.revision }),
      { status: 'not_available', invalidationReason: 'scope_revoked' },
    );
  });

  test('rejects cross-owner, cross-thread, cat-authored, deleted, and tombstoned sources', async () => {
    const { PersonMemoryCueSource } = await import('../../dist/domains/memory/cue/sources/PersonMemoryCueSource.js');
    const invalidMessages = [
      { ...currentMessage, userId: 'other-owner' },
      { ...currentMessage, threadId: 'thread-other' },
      { ...currentMessage, catId: 'opus' },
      { ...currentMessage, deletedAt: 1_785_600_000_001 },
      { ...currentMessage, _tombstone: true },
    ];
    for (const message of invalidMessages) {
      const source = new PersonMemoryCueSource({
        recall: {
          recallByWorkspaceEntityRef: async () => {
            throw new Error('invalid source must stop before recall');
          },
        },
        messageStore: { getById: async () => message },
      });
      assert.equal(
        await source.resolve({
          ownerUserId: 'owner-1',
          threadId: 'thread-current',
          entityId: 'person:alden',
          matchedAlias: 'Alden',
          sourceMessageId: 'message-current',
        }),
        null,
      );
    }
  });
});
