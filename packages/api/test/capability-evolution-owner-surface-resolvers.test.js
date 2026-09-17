import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createEvolutionOwnerSurfaceResolvers } from '../dist/infrastructure/capability-evolution/program-owner-surface-resolvers.js';

const pawInput = {
  ownerUserId: 'owner-a',
  ownerSurfaceRef: { ownerFeatureId: 'F278', ownerStateRef: 'paw-feel:signal-1' },
  joinKey: 'message:message-1',
  instrumentationRef: { ownerFeatureId: 'F278', ownerStateRef: 'instrumentation:paw-feel-v1' },
};

const humanInput = {
  ownerUserId: 'owner-a',
  ownerSurfaceRef: { ownerFeatureId: 'F281', ownerStateRef: 'human-disposition:decision-1' },
  joinKey: 'subject:proposal-1',
  instrumentationRef: { ownerFeatureId: 'F281', ownerStateRef: 'instrumentation:human-disposition-v1' },
};

const ownerMessageInput = {
  ownerUserId: 'owner-a',
  ownerSurfaceRef: { ownerFeatureId: 'F117', ownerStateRef: 'message:message-correction-1' },
  joinKey: 'thread:thread-source',
  instrumentationRef: { ownerFeatureId: 'F117', ownerStateRef: 'instrumentation:owner-message-v1' },
};

function dependencies({
  sourceThreadOwner = 'owner-a',
  messageOwner = 'owner-a',
  messageThreadId = 'thread-source',
  messageSource,
  messageSourceParseFailure,
  messageVisibility,
  messageWhisperTo,
  messageRevealedAt,
  messageDeletedAt,
  messageTombstone,
  messageDeliveryStatus = 'delivered',
} = {}) {
  return {
    pawFeelEventLog: {
      async read() {
        return [
          {
            type: 'discovered',
            source: { sourceMessageId: 'message-1', sourceThreadId: 'thread-source' },
          },
        ];
      },
    },
    humanDispositionLedger: {
      async get(ownerUserId, sourceRef) {
        return ownerUserId === 'owner-a' && sourceRef === 'decision-1'
          ? { episode: { subjectRef: 'proposal-1' } }
          : null;
      },
    },
    messageStore: {
      async getById(messageId) {
        return messageId === 'message-correction-1'
          ? {
              id: messageId,
              threadId: messageThreadId,
              userId: messageOwner,
              catId: null,
              content: '这次偏离了我原来的意思。',
              timestamp: 1,
              mentions: [],
              source: messageSource,
              sourceParseFailure: messageSourceParseFailure,
              visibility: messageVisibility,
              whisperTo: messageWhisperTo,
              revealedAt: messageRevealedAt,
              deletedAt: messageDeletedAt,
              _tombstone: messageTombstone,
              deliveryStatus: messageDeliveryStatus,
            }
          : null;
      },
    },
    threadStore: {
      async get() {
        return { createdBy: sourceThreadOwner };
      },
    },
  };
}

describe('F311 canonical owner surface resolvers', () => {
  it('resolves F278 and F281 through their owner read ports for the authenticated owner', async () => {
    const resolvers = createEvolutionOwnerSurfaceResolvers(dependencies());

    assert.deepEqual(await resolvers['paw-feel-disposition'](pawInput), { status: 'resolved' });
    assert.deepEqual(await resolvers['human-disposition'](humanInput), { status: 'resolved' });
  });

  it('resolves a delivered direct owner message without classifying or copying its correction text', async () => {
    const resolver = createEvolutionOwnerSurfaceResolvers(dependencies())['owner-message'];

    assert.deepEqual(await resolver(ownerMessageInput), { status: 'resolved' });
  });

  it('fails direct owner message joins closed across owner, thread, source, deletion, or delivery boundaries', async () => {
    const cases = [
      dependencies({ messageOwner: 'owner-b' }),
      dependencies({ messageThreadId: 'thread-other' }),
      dependencies({ messageSource: { connector: 'lark' } }),
      dependencies({ messageDeletedAt: 2 }),
      dependencies({ messageTombstone: true }),
      dependencies({ messageDeliveryStatus: 'queued' }),
      dependencies({ sourceThreadOwner: 'owner-b' }),
    ];

    for (const deps of cases) {
      const resolver = createEvolutionOwnerSurfaceResolvers(deps)['owner-message'];
      assert.deepEqual(await resolver(ownerMessageInput), { status: 'missing' });
    }
  });

  it('rejects source-corrupt rows instead of reinterpreting them as direct owner messages', async () => {
    const resolver = createEvolutionOwnerSurfaceResolvers(dependencies({ messageSourceParseFailure: true }))[
      'owner-message'
    ];

    assert.deepEqual(await resolver(ownerMessageInput), { status: 'missing' });
  });

  it('rejects unrevealed whispers but accepts the same owner message after it becomes public', async () => {
    const hiddenResolver = createEvolutionOwnerSurfaceResolvers(
      dependencies({ messageVisibility: 'whisper', messageWhisperTo: ['cat-x'] }),
    )['owner-message'];
    const revealedResolver = createEvolutionOwnerSurfaceResolvers(
      dependencies({
        messageVisibility: 'whisper',
        messageWhisperTo: ['cat-x'],
        messageRevealedAt: 2,
      }),
    )['owner-message'];

    assert.deepEqual(await hiddenResolver(ownerMessageInput), { status: 'missing' });
    assert.deepEqual(await revealedResolver(ownerMessageInput), { status: 'resolved' });
  });

  it('does not connect a paw-feel source from another user thread', async () => {
    const resolver = createEvolutionOwnerSurfaceResolvers(dependencies({ sourceThreadOwner: 'owner-b' }))[
      'paw-feel-disposition'
    ];

    assert.deepEqual(await resolver(pawInput), { status: 'missing' });
  });

  it('rejects caller-invented instrumentation refs that the source adapter did not register', async () => {
    const resolvers = createEvolutionOwnerSurfaceResolvers(dependencies());

    assert.deepEqual(
      await resolvers['paw-feel-disposition']({
        ...pawInput,
        instrumentationRef: { ownerFeatureId: 'F278', ownerStateRef: 'instrumentation:caller-draft' },
      }),
      { status: 'missing' },
    );
    assert.deepEqual(
      await resolvers['human-disposition']({
        ...humanInput,
        instrumentationRef: { ownerFeatureId: 'F281', ownerStateRef: 'instrumentation:caller-draft' },
      }),
      { status: 'missing' },
    );
    assert.deepEqual(
      await resolvers['owner-message']({
        ...ownerMessageInput,
        instrumentationRef: { ownerFeatureId: 'F117', ownerStateRef: 'instrumentation:caller-draft' },
      }),
      { status: 'missing' },
    );
  });

  it('fails the owner port closed when the backing capability is unavailable', async () => {
    const resolvers = createEvolutionOwnerSurfaceResolvers({
      threadStore: {
        async get() {
          return null;
        },
      },
    });

    await assert.rejects(() => resolvers['paw-feel-disposition'](pawInput), /owner read port is unavailable/);
    await assert.rejects(() => resolvers['human-disposition'](humanInput), /owner read port is unavailable/);
    await assert.rejects(() => resolvers['owner-message'](ownerMessageInput), /owner read port is unavailable/);
  });
});
