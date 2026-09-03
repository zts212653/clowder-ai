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

function dependencies({ sourceThreadOwner = 'owner-a' } = {}) {
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
  });
});
