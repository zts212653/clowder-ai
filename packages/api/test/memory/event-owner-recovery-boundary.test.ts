import assert from 'node:assert/strict';
import { it } from 'node:test';
import { SessionMutex } from '../../src/domains/cats/services/agents/invocation/SessionMutex.js';
import { EventMemoryStore, eventMemoryRevision } from '../../src/domains/memory/EventMemoryStore.js';
import { EventMemoryLifecycleService } from '../../src/domains/memory/event/EventMemoryLifecycleService.js';
import {
  InMemoryOwnerMemoryActionReceiptStore,
  OwnerMemoryActionCoordinator,
} from '../../src/domains/memory/owner/OwnerMemoryActionCoordinator.js';
import type { OwnerMemoryActionReceiptRecord } from '../../src/domains/memory/owner/OwnerMemoryActionReceiptStore.js';

it('does not report a never-owned target forgotten after losing the pending-receipt acknowledgement', async () => {
  class InterruptedReceiptStore extends InMemoryOwnerMemoryActionReceiptStore {
    private interrupted = false;
    override async begin(record: OwnerMemoryActionReceiptRecord) {
      const saved = await super.begin(record);
      if (!this.interrupted) {
        this.interrupted = true;
        throw new Error('lost pending acknowledgement before mutation');
      }
      return saved;
    }
  }
  let mutations = 0;
  const service = new EventMemoryLifecycleService({
    store: {
      getEvent: () => null,
      correctEvent: () => {
        mutations++;
        return { outcome: 'not_available' };
      },
      retireEvent: () => {
        mutations++;
        return { outcome: 'not_available' };
      },
      hardForgetEvent: () => {
        mutations++;
        return { outcome: 'not_available' };
      },
    },
    coordinator: new OwnerMemoryActionCoordinator({ store: new InterruptedReceiptStore(), lock: new SessionMutex() }),
    sourceAvailable: async () => false,
  });
  const command = {
    action: 'hard_forget' as const,
    requestId: 'event-forget:018f2d5e-9f45-7d8c-a829-88f6440a4f15',
    expectedRevision: `sha256:${'a'.repeat(64)}`,
    confirmed: true as const,
  };
  await service.executeOwnerAction('owner', 'never-owned-event', command).then(
    (result) => assert.deepEqual(result, { error: 'not_available' }),
    (error: Error) => assert.match(error.message, /lost pending acknowledgement/),
  );
  const result = await service.executeOwnerAction('owner', 'never-owned-event', command);
  assert.deepEqual(result, { error: 'not_available' });
  assert.equal(mutations, 0);
});

it('recovers hard-forget only from the durable Event tombstone written by the mutation', async () => {
  class LostCompletionStore extends InMemoryOwnerMemoryActionReceiptStore {
    private interrupted = false;
    override async complete(...args: Parameters<InMemoryOwnerMemoryActionReceiptStore['complete']>) {
      if (!this.interrupted) {
        this.interrupted = true;
        throw new Error('lost completion before receipt commit');
      }
      return super.complete(...args);
    }
  }
  const eventStore = new EventMemoryStore(':memory:');
  await eventStore.initialize();
  const event = eventStore.markEvent(
    {
      type: 'scope_correction',
      trigger: 'human_brake',
      cat: 'codex-sol',
      threadId: 'thread-source',
      messageId: 'message-source',
      timestamp: 100,
      summary: 'Forget this derived Event.',
      cognitiveTransition: 'scope_correction',
      relatedHarness: ['F321'],
      confidence: 'high',
    },
    'owner',
  ).event;
  assert.ok(event);
  const service = new EventMemoryLifecycleService({
    store: eventStore,
    coordinator: new OwnerMemoryActionCoordinator({ store: new LostCompletionStore(), lock: new SessionMutex() }),
    sourceAvailable: async () => true,
  });
  const command = {
    action: 'hard_forget' as const,
    requestId: 'event-forget:118f2d5e-9f45-7d8c-a829-88f6440a4f15',
    expectedRevision: eventMemoryRevision(event),
    confirmed: true as const,
  };

  await assert.rejects(service.executeOwnerAction('owner', event.eventId, command), /lost completion/);
  assert.equal(eventStore.getEvent(event.eventId), null);
  assert.equal(eventStore.hasHardForgetTombstone(event.eventId, 'owner'), true);
  const recovered = await service.executeOwnerAction('owner', event.eventId, command);
  assert.equal(recovered.outcome, 'replayed');
  assert.equal(recovered.action, 'hard_forget');
});
