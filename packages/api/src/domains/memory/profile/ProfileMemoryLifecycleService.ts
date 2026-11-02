import type { MemoryOwnerActionError, MemoryOwnerActionReceipt, ProfileMemoryOwnerAction } from '@cat-cafe/shared';
import { renderUserCapsuleSection } from '@cat-cafe/shared/profile-contract';
import type { SessionMutex } from '../../cats/services/agents/invocation/SessionMutex.js';
import type { OwnerMemoryActionCoordinator } from '../owner/OwnerMemoryActionCoordinator.js';
import type { ProfileMemoryLifecycleStore, ProfileMemoryMutationResult } from './ProfileMemoryLifecycleStore.js';

type ProfileLifecycleStore = Pick<
  ProfileMemoryLifecycleStore,
  'get' | 'replaceContent' | 'hardForget' | 'getOwnerActionEvidence' | 'commandDigest' | 'finishHardForgetCleanup'
> &
  Partial<Pick<ProfileMemoryLifecycleStore, 'lockKey'>>;

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
    if (memoryId === 'capsule' && command.action === 'replace_content') {
      try {
        if (!renderUserCapsuleSection(command.content)) return Promise.resolve({ error: 'invalid_content' });
      } catch {
        return Promise.resolve({ error: 'invalid_content' });
      }
    }
    return this.deps.coordinator.execute(
      { ownerUserId, lane: 'profile', memoryId, requestId: command.requestId, command },
      {
        recover: () => this.recover(ownerUserId, memoryId, command),
        run: () => this.run(ownerUserId, memoryId, command),
      },
    );
  }

  private async run(ownerUserId: string, memoryId: string, command: ProfileMemoryOwnerAction) {
    const projected = await this.withTargetLock(ownerUserId, memoryId, () => {
      const evidence = this.deps.store.getOwnerActionEvidence(ownerUserId, memoryId, command.requestId);
      const current = this.deps.store.get(ownerUserId, memoryId);
      const creatingCapsule = memoryId === 'capsule' && command.action === 'replace_content';
      if (!current && !evidence && !creatingCapsule) return { error: 'not_available' as const };
      if (current && current.revision !== command.expectedRevision && !evidence) {
        return { error: 'stale_revision' as const };
      }
      const result =
        command.action === 'replace_content'
          ? this.deps.store.replaceContent({ ownerUserId, memoryId, command })
          : this.deps.store.hardForget({ ownerUserId, memoryId, command });
      return projectMutation(command.action, memoryId, result);
    });
    if ('error' in projected) return rejected(projected.error);
    await this.invalidate(ownerUserId, memoryId, command.action);
    return { status: 'applied' as const, receipt: projected };
  }

  private async recover(
    ownerUserId: string,
    memoryId: string,
    command: ProfileMemoryOwnerAction,
  ): Promise<MemoryOwnerActionReceipt | null> {
    const evidence = this.deps.store.getOwnerActionEvidence(ownerUserId, memoryId, command.requestId);
    if (
      !evidence?.applied ||
      evidence.action !== command.action ||
      evidence.commandDigest !== this.deps.store.commandDigest(command)
    ) {
      return null;
    }
    if (command.action === 'hard_forget') {
      await this.withTargetLock(ownerUserId, memoryId, () => {
        this.deps.store.finishHardForgetCleanup(ownerUserId, memoryId, command.requestId);
      });
    }
    await this.invalidate(ownerUserId, memoryId, command.action);
    if (command.action === 'replace_content') {
      if (!evidence.revision) return null;
      return {
        action: command.action,
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
  result: ProfileMemoryMutationResult,
): Omit<MemoryOwnerActionReceipt, 'outcome'> | { error: MemoryOwnerActionError } {
  if (
    result.outcome === 'not_available' ||
    result.outcome === 'stale_revision' ||
    result.outcome === 'idempotency_conflict'
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
