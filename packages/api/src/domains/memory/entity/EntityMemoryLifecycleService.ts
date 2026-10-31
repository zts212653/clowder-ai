import type { EntityMemoryOwnerAction, MemoryOwnerActionError, MemoryOwnerActionReceipt } from '@cat-cafe/shared';
import { EntitySurfaceConflictError, entitySourceRevision, type StoredEntityRecord } from '../EntityRegistry.js';
import type { OwnerMemoryActionCoordinator } from '../owner/OwnerMemoryActionCoordinator.js';
import type { EntityMemoryLifecycleStore, EntityMemoryMutationResult } from './EntityMemoryLifecycleStore.js';

export class EntityMemoryLifecycleService {
  private readonly now: () => number;

  constructor(
    private readonly deps: {
      store: Pick<EntityMemoryLifecycleStore, 'get' | 'correct' | 'retire' | 'hardForget' | 'getOwnerActionEvidence'>;
      coordinator: OwnerMemoryActionCoordinator;
      sourceAvailable: (entity: StoredEntityRecord) => Promise<boolean>;
      now?: () => number;
    },
  ) {
    this.now = deps.now ?? Date.now;
  }

  executeOwnerAction(
    ownerUserId: string,
    entityId: string,
    command: EntityMemoryOwnerAction,
  ): Promise<MemoryOwnerActionReceipt | { error: MemoryOwnerActionError }> {
    return this.deps.coordinator.execute(
      { ownerUserId, lane: 'entity', memoryId: entityId, requestId: command.requestId, command },
      {
        recover: () => this.recover(ownerUserId, entityId, command),
        run: () => this.run(ownerUserId, entityId, command),
      },
    );
  }

  private async run(ownerUserId: string, entityId: string, command: EntityMemoryOwnerAction) {
    const current = this.deps.store.get(entityId);
    if (!current) return rejected('not_available');
    if (entitySourceRevision(current) !== command.expectedRevision) return rejected('stale_revision');
    if (command.action !== 'hard_forget' && current.status !== 'active') return rejected('not_available');
    if (command.action === 'correct' && !(await this.deps.sourceAvailable(current))) {
      return rejected('source_unavailable');
    }
    let result: EntityMemoryMutationResult;
    try {
      result = this.applyMutation(ownerUserId, entityId, command);
    } catch (error) {
      if (error instanceof EntitySurfaceConflictError) return rejected('conflict');
      throw error;
    }
    const projected = projectMutation(command.action, entityId, result);
    return 'error' in projected
      ? { status: 'rejected' as const, error: projected.error }
      : { status: 'applied' as const, receipt: projected };
  }

  private applyMutation(
    ownerUserId: string,
    entityId: string,
    command: EntityMemoryOwnerAction,
  ): EntityMemoryMutationResult {
    const base = {
      ownerUserId,
      entityId,
      expectedRevision: command.expectedRevision,
      requestId: command.requestId,
      updatedAt: this.now(),
    };
    if (command.action === 'correct') return this.deps.store.correct({ ...base, patch: command.patch });
    if (command.action === 'retire') return this.deps.store.retire(base);
    return this.deps.store.hardForget(base);
  }

  private async recover(
    ownerUserId: string,
    entityId: string,
    command: EntityMemoryOwnerAction,
  ): Promise<MemoryOwnerActionReceipt | null> {
    const evidence = this.deps.store.getOwnerActionEvidence(entityId, ownerUserId, command.requestId);
    if (!evidence || evidence.action !== command.action) return null;
    if (evidence.action === 'hard_forget') return forgottenReceipt(entityId);
    if (!evidence.revision || !evidence.status) return null;
    return {
      action: evidence.action,
      outcome: 'applied',
      memoryId: entityId,
      revision: evidence.revision,
      status: evidence.status,
    };
  }
}

function projectMutation(
  action: EntityMemoryOwnerAction['action'],
  entityId: string,
  result: EntityMemoryMutationResult,
): MemoryOwnerActionReceipt | { error: MemoryOwnerActionError } {
  if (result.outcome === 'not_available' || result.outcome === 'stale_revision') return { error: result.outcome };
  if (action === 'hard_forget') {
    if (result.outcome !== 'forgotten') throw new Error('Entity hard-forget returned an invalid store outcome');
    return forgottenReceipt(entityId);
  }
  if (result.outcome !== 'applied') throw new Error(`Entity ${action} returned an invalid store outcome`);
  return {
    action,
    outcome: 'applied',
    memoryId: entityId,
    revision: entitySourceRevision(result.entity),
    status: result.entity.status as 'active' | 'retired',
  };
}

function forgottenReceipt(entityId: string): MemoryOwnerActionReceipt {
  return {
    action: 'hard_forget',
    outcome: 'applied',
    memoryId: entityId,
    forgetScope: {
      canonicalMemory: 'deleted',
      derivedProjections: 'invalidated',
      originalSource: 'preserved',
      immutableAudit: 'retained',
    },
  };
}

function rejected(error: MemoryOwnerActionError) {
  return { status: 'rejected' as const, error };
}
