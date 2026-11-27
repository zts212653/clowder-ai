import type { EntityMemoryOwnerAction, MemoryOwnerActionError, MemoryOwnerActionReceipt } from '@cat-cafe/shared';
import type { EntityMemoryMutation, EntityMemoryRecord } from '@clowder-ai/plugin-memory-contract/entity';
import type { createEntityMemoryProvider } from '../../plugin/host-surface/memory/entity-memory-provider.js';
import type { OwnerMemoryActionCoordinator } from '../owner/OwnerMemoryActionCoordinator.js';

export class EntityMemoryLifecycleService {
  private readonly now: () => number;

  constructor(
    private readonly deps: {
      store: Pick<ReturnType<typeof createEntityMemoryProvider>, 'get' | 'mutate' | 'evidence'>;
      coordinator: OwnerMemoryActionCoordinator;
      sourceAvailable: (entity: EntityMemoryRecord) => Promise<boolean>;
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
    const current = await this.deps.store.get(ownerUserId, entityId);
    if (!current) return rejected('not_available');
    if (current.revision !== command.expectedRevision) return rejected('stale_revision');
    if (command.action !== 'hard_forget' && current.status !== 'active') return rejected('not_available');
    if (command.action === 'correct' && !(await this.deps.sourceAvailable(current))) {
      return rejected('source_unavailable');
    }
    const result = await this.deps.store.mutate(ownerUserId, entityId, command, this.now());
    const projected = projectMutation(command.action, entityId, result);
    return 'error' in projected
      ? { status: 'rejected' as const, error: projected.error }
      : { status: 'applied' as const, receipt: projected };
  }

  private async recover(
    ownerUserId: string,
    entityId: string,
    command: EntityMemoryOwnerAction,
  ): Promise<MemoryOwnerActionReceipt | null> {
    const evidence = await this.deps.store.evidence(ownerUserId, entityId, command.requestId);
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
  result: EntityMemoryMutation,
): MemoryOwnerActionReceipt | { error: MemoryOwnerActionError } {
  if (result.outcome === 'not_available' || result.outcome === 'stale_revision' || result.outcome === 'conflict') {
    return { error: result.outcome };
  }
  if (action === 'hard_forget') {
    if (result.outcome !== 'forgotten') throw new Error('Entity hard-forget returned an invalid store outcome');
    return forgottenReceipt(entityId);
  }
  if (result.outcome !== 'applied') throw new Error(`Entity ${action} returned an invalid store outcome`);
  return {
    action,
    outcome: 'applied',
    memoryId: entityId,
    revision: result.entity.revision,
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
