import type { MemoryOwnerActionError, MemoryOwnerActionReceipt, ProfileMemoryOwnerAction } from '@cat-cafe/shared';
import type { ProfileMemoryMutation, ProfileMemoryRecovery } from '@clowder-ai/plugin-memory-contract/profile';
import type { SessionMutex } from '../../cats/services/agents/invocation/SessionMutex.js';
import type { OwnerMemoryActionCoordinator } from '../owner/OwnerMemoryActionCoordinator.js';

type ProfileActionInput = [owner: string, memoryId: string, command: ProfileMemoryOwnerAction];

interface ProfileLifecycleStore {
  mutate: (...input: ProfileActionInput) => Promise<ProfileMemoryMutation>;
  recover: (...input: ProfileActionInput) => Promise<ProfileMemoryRecovery>;
  lockKey?(ownerUserId: string, memoryId: string): string | null;
}

export interface ProfileMemoryDerivedInvalidation {
  ownerUserId: string;
  memoryId: string;
  action: ProfileMemoryOwnerAction['action'];
}

export class ProfileMemoryLifecycleService {
  constructor(
    private readonly deps: {
      store: ProfileLifecycleStore;
      coordinator: OwnerMemoryActionCoordinator;
      targetLock?: SessionMutex;
      invalidateDerived: (input: ProfileMemoryDerivedInvalidation) => Promise<void>;
    },
  ) {}

  executeOwnerAction(
    ownerUserId: string,
    memoryId: string,
    command: ProfileMemoryOwnerAction,
  ): Promise<MemoryOwnerActionReceipt | { error: MemoryOwnerActionError }> {
    return this.deps.coordinator.execute(
      { ownerUserId, lane: 'profile', memoryId, requestId: command.requestId, command },
      {
        recover: () => this.recover(ownerUserId, memoryId, command),
        run: () => this.run(ownerUserId, memoryId, command),
      },
    );
  }

  private async run(ownerUserId: string, memoryId: string, command: ProfileMemoryOwnerAction) {
    const result = await this.withTargetLock(ownerUserId, memoryId, () =>
      this.deps.store.mutate(ownerUserId, memoryId, command),
    );
    const projected = projectMutation(command.action, memoryId, result);
    if ('error' in projected) return rejected(projected.error);
    await this.invalidate(ownerUserId, memoryId, command.action);
    return { status: 'applied' as const, receipt: projected };
  }

  private async recover(
    ownerUserId: string,
    memoryId: string,
    command: ProfileMemoryOwnerAction,
  ): Promise<MemoryOwnerActionReceipt | null> {
    const evidence = await this.withTargetLock(ownerUserId, memoryId, () =>
      this.deps.store.recover(ownerUserId, memoryId, command),
    );
    if (!evidence || evidence.action !== command.action) return null;
    await this.invalidate(ownerUserId, memoryId, command.action);
    if (evidence.action === 'replace_content') {
      return {
        action: evidence.action,
        outcome: 'applied',
        memoryId,
        revision: evidence.revision,
        status: 'active',
      };
    }
    return forgottenReceipt(memoryId);
  }

  private invalidate(ownerUserId: string, memoryId: string, action: ProfileMemoryOwnerAction['action']) {
    return this.deps.invalidateDerived({ ownerUserId, memoryId, action });
  }

  private async withTargetLock<T>(ownerUserId: string, memoryId: string, action: () => T | Promise<T>): Promise<T> {
    const lockKey = this.deps.store.lockKey?.(ownerUserId, memoryId);
    if (!this.deps.targetLock || !lockKey) return action();
    const release = await this.deps.targetLock.acquire(lockKey);
    try {
      return await action();
    } finally {
      release();
    }
  }
}

function projectMutation(
  action: ProfileMemoryOwnerAction['action'],
  memoryId: string,
  result: ProfileMemoryMutation,
): Omit<MemoryOwnerActionReceipt, 'outcome'> | { error: MemoryOwnerActionError } {
  if (
    result.outcome === 'not_available' ||
    result.outcome === 'stale_revision' ||
    result.outcome === 'idempotency_conflict' ||
    result.outcome === 'invalid_content'
  ) {
    return { error: result.outcome };
  }
  if (action === 'hard_forget') {
    if (result.outcome !== 'forgotten') throw new Error('Profile hard-forget returned an invalid store outcome');
    return forgottenReceipt(memoryId);
  }
  if (result.outcome !== 'applied') throw new Error('Profile replacement returned an invalid store outcome');
  return {
    action,
    memoryId,
    revision: result.entry.revision,
    status: 'active',
  };
}

function forgottenReceipt(memoryId: string): MemoryOwnerActionReceipt {
  return {
    action: 'hard_forget',
    outcome: 'applied',
    memoryId,
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
