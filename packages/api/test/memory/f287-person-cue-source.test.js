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

describe('F287 person cue canonical source', () => {
  test('binds the exact workspace entity and drills owner-visible cross-thread history', async () => {
    const { PersonMemoryCueSource } = await import('../../dist/domains/memory/cue/sources/PersonMemoryCueSource.js');
    const calls = [];
    const recall = {
      async recallByWorkspaceEntityRef(ownerUserId, entityRef) {
        calls.push({ ownerUserId, entityRef });
        return ownerUserId === 'owner-1' && entityRef === 'person:alden'
          ? { status: 'resolved', card }
          : { status: 'not_available' };
      },
      async recallByPersonId(ownerUserId, personId) {
        return ownerUserId === 'owner-1' && personId === card.personId
          ? { status: 'resolved', card }
          : { status: 'not_available' };
      },
      async recallByAlias() {
        throw new Error('alias recall must not replace the typed entity binding');
      },
    };
    const source = new PersonMemoryCueSource({
      recall,
      messageStore: { getById: async () => currentMessage },
    });

    const exact = await source.resolve({
      ownerUserId: 'owner-1',
      threadId: 'thread-current',
      entityId: 'person:alden',
      matchedAlias: 'Alden',
      sourceMessageId: 'message-current',
    });
    assert.equal(exact.anchor, 'person-memory:person-private-alden');
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
