import type {
  EventMemoryCorrectionPatch,
  EventMemoryOwnerAction,
  MemoryOwnerActionError,
  MemoryOwnerActionReceipt,
} from '@cat-cafe/shared';
import type { EventMemoryMutationResult, IEventMemoryStore, StoredEventMemoryLifecycle } from '../EventMemoryStore.js';
import { eventMemoryRevision } from '../EventMemoryStore.js';
import type { OwnerMemoryActionCoordinator } from '../owner/OwnerMemoryActionCoordinator.js';

export class EventMemoryLifecycleService {
  private readonly now: () => number;

  constructor(
    private readonly deps: {
      store: Pick<IEventMemoryStore, 'getEvent' | 'correctEvent' | 'retireEvent' | 'hardForgetEvent'> &
        Partial<Pick<IEventMemoryStore, 'getOwnerActionEvidence'>>;
      coordinator: OwnerMemoryActionCoordinator;
      sourceAvailable: (event: StoredEventMemoryLifecycle) => Promise<boolean>;
      now?: () => number;
    },
  ) {
    this.now = deps.now ?? Date.now;
  }

  executeOwnerAction(
    ownerUserId: string,
    eventId: string,
    command: EventMemoryOwnerAction,
  ): Promise<MemoryOwnerActionReceipt | { error: MemoryOwnerActionError }> {
    return this.deps.coordinator.execute(
      { ownerUserId, lane: 'event', memoryId: eventId, requestId: command.requestId, command },
      {
        recover: () => this.recover(ownerUserId, eventId, command),
        run: () => this.run(ownerUserId, eventId, command),
      },
    );
  }

  async applyApprovedCorrection(input: {
    ownerUserId: string;
    eventId: string;
    expectedRevision: string;
    patch: EventMemoryCorrectionPatch;
    requestId: string;
  }): Promise<MemoryOwnerActionReceipt | { error: MemoryOwnerActionError }> {
    return this.executeOwnerAction(input.ownerUserId, input.eventId, {
      action: 'correct',
      requestId: input.requestId,
      expectedRevision: input.expectedRevision,
      patch: input.patch,
    });
  }

  private async run(
    ownerUserId: string,
    eventId: string,
    command: EventMemoryOwnerAction,
  ): Promise<
    { status: 'applied'; receipt: MemoryOwnerActionReceipt } | { status: 'rejected'; error: MemoryOwnerActionError }
  > {
    const current = this.ownedEvent(ownerUserId, eventId);
    if (!current) return { status: 'rejected', error: 'not_available' };
    if (eventMemoryRevision(current) !== command.expectedRevision) {
      return { status: 'rejected', error: 'stale_revision' };
    }
    if (command.action === 'correct' && !(await this.deps.sourceAvailable(current))) {
      return { status: 'rejected', error: 'source_unavailable' };
    }

    const mutation = this.applyStoreMutation(ownerUserId, eventId, command);
    const projected = this.projectMutation(command.action, eventId, mutation);
    return 'error' in projected
      ? { status: 'rejected', error: projected.error }
      : { status: 'applied', receipt: projected };
  }

  private applyStoreMutation(
    ownerUserId: string,
    eventId: string,
    command: EventMemoryOwnerAction,
  ): EventMemoryMutationResult {
    if (command.action === 'correct') {
      return this.deps.store.correctEvent({
        eventId,
        ownerUserId,
        expectedRevision: command.expectedRevision,
        patch: command.patch,
        requestId: command.requestId,
        updatedAt: this.now(),
      });
    }
    if (command.action === 'retire') {
      return this.deps.store.retireEvent({
        eventId,
        ownerUserId,
        expectedRevision: command.expectedRevision,
        requestId: command.requestId,
        updatedAt: this.now(),
      });
    }
    return this.deps.store.hardForgetEvent({
      eventId,
      ownerUserId,
      expectedRevision: command.expectedRevision,
      requestId: command.requestId,
    });
  }

  private async recover(
    ownerUserId: string,
    eventId: string,
    command: EventMemoryOwnerAction,
  ): Promise<MemoryOwnerActionReceipt | null> {
    const evidence = this.deps.store.getOwnerActionEvidence?.(eventId, ownerUserId, command.requestId);
    if (!evidence || evidence.action !== command.action) return null;
    if (evidence.action === 'hard_forget') return forgottenReceipt(eventId);
    if (!evidence.revision || !evidence.status) return null;
    return {
      action: evidence.action,
      outcome: 'applied',
      memoryId: eventId,
      revision: evidence.revision,
      status: evidence.status,
    };
  }

  private ownedEvent(ownerUserId: string, eventId: string): StoredEventMemoryLifecycle | null {
    const event = this.deps.store.getEvent(eventId);
    return event?.ownerUserId === ownerUserId ? event : null;
  }

  private projectMutation(
    action: EventMemoryOwnerAction['action'],
    eventId: string,
    result: EventMemoryMutationResult,
  ): MemoryOwnerActionReceipt | { error: MemoryOwnerActionError } {
    if (result.outcome === 'not_available' || result.outcome === 'stale_revision') {
      return { error: result.outcome };
    }
    if (action === 'hard_forget') {
      if (result.outcome !== 'forgotten') throw new Error('Event hard-forget returned an invalid store outcome');
      return forgottenReceipt(eventId);
    }
    if (result.outcome !== 'applied') throw new Error(`Event ${action} returned an invalid store outcome`);
    return activeReceipt(action, result.event);
  }
}

function activeReceipt(
  action: Extract<EventMemoryOwnerAction['action'], 'correct' | 'retire'>,
  event: StoredEventMemoryLifecycle,
): MemoryOwnerActionReceipt {
  return {
    action,
    outcome: 'applied',
    memoryId: event.eventId,
    revision: eventMemoryRevision(event),
    status: event.status,
  };
}

function forgottenReceipt(eventId: string): MemoryOwnerActionReceipt {
  return {
    action: 'hard_forget',
    outcome: 'applied',
    memoryId: eventId,
    forgetScope: {
      canonicalMemory: 'deleted',
      derivedProjections: 'invalidated',
      originalSource: 'preserved',
      immutableAudit: 'not_applicable',
    },
  };
}
