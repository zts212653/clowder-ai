import type {
  AcquireBacklogLeaseInput,
  AtomicDispatchInput,
  BacklogDependencies,
  BacklogItem,
  BacklogLease,
  BacklogStatus,
  CreateBacklogItemInput,
  DecideBacklogClaimInput,
  DispatchBacklogItemInput,
  HeartbeatBacklogLeaseInput,
  MarkDoneInput,
  ReclaimBacklogLeaseInput,
  RefreshBacklogItemInput,
  ReleaseBacklogLeaseInput,
  SuggestBacklogClaimInput,
  UpdateBacklogDispatchProgressInput,
} from '@cat-cafe/shared';
import { makeCatActor, makeCreatorActor, makeUserActor } from '../shared/backlog-audit-actors.js';
import { generateSortableId } from './MessageStore.js';

const MAX_BACKLOG_ITEMS = 1000;

const EVICTION_PRIORITY: Record<BacklogStatus, number> = {
  done: 0,
  dispatched: 0,
  open: 1,
  suggested: 2,
  approved: 3,
};

export class BacklogTransitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BacklogTransitionError';
  }
}

export interface IBacklogStore {
  create(input: CreateBacklogItemInput): BacklogItem | Promise<BacklogItem>;
  refreshMetadata(itemId: string, input: RefreshBacklogItemInput): BacklogItem | null | Promise<BacklogItem | null>;
  get(itemId: string, userId?: string): BacklogItem | null | Promise<BacklogItem | null>;
  listByUser(userId: string): BacklogItem[] | Promise<BacklogItem[]>;
  suggestClaim(itemId: string, input: SuggestBacklogClaimInput): BacklogItem | null | Promise<BacklogItem | null>;
  decideClaim(itemId: string, input: DecideBacklogClaimInput): BacklogItem | null | Promise<BacklogItem | null>;
  updateDispatchProgress(
    itemId: string,
    input: UpdateBacklogDispatchProgressInput,
  ): BacklogItem | null | Promise<BacklogItem | null>;
  markDispatched(itemId: string, input: DispatchBacklogItemInput): BacklogItem | null | Promise<BacklogItem | null>;
  markDone(itemId: string, input: MarkDoneInput): BacklogItem | null | Promise<BacklogItem | null>;
  acquireLease(itemId: string, input: AcquireBacklogLeaseInput): BacklogItem | null | Promise<BacklogItem | null>;
  heartbeatLease(itemId: string, input: HeartbeatBacklogLeaseInput): BacklogItem | null | Promise<BacklogItem | null>;
  releaseLease(itemId: string, input: ReleaseBacklogLeaseInput): BacklogItem | null | Promise<BacklogItem | null>;
  reclaimExpiredLease(
    itemId: string,
    input: ReclaimBacklogLeaseInput,
  ): BacklogItem | null | Promise<BacklogItem | null>;
  /** Optional: acquire a short-lived dispatch lock to prevent concurrent dispatch races (Redis only). Returns a token on success, false if already locked. */
  tryAcquireDispatchLock?(itemId: string, ttlMs?: number): Promise<string | false>;
  /** Optional: release dispatch lock after successful dispatch (Redis only). Token must match the one returned by tryAcquireDispatchLock. */
  releaseDispatchLock?(itemId: string, token: string): Promise<void>;
  /** Optional: atomic dispatch combining progress update + markDispatched in one operation. */
  atomicDispatch?(itemId: string, input: AtomicDispatchInput): BacklogItem | null | Promise<BacklogItem | null>;
}

export class BacklogStore implements IBacklogStore {
  private readonly items: Map<string, BacklogItem> = new Map();
  private readonly maxItems: number;

  constructor(options?: { maxItems?: number }) {
    this.maxItems = options?.maxItems ?? MAX_BACKLOG_ITEMS;
  }

  create(input: CreateBacklogItemInput): BacklogItem {
    this.evictIfNeeded();

    const now = Date.now();
    const id = generateSortableId(now);
    const item: BacklogItem = {
      id,
      userId: input.userId,
      title: input.title,
      summary: input.summary,
      priority: input.priority,
      tags: [...input.tags],
      status: input.initialStatus ?? 'open',
      createdBy: input.createdBy,
      ...(input.dependencies ? { dependencies: input.dependencies } : {}),
      ...(input.projectId ? { projectId: input.projectId } : {}),
      createdAt: now,
      updatedAt: now,
      audit: [
        {
          id: generateSortableId(now + 1),
          action: 'created',
          actor: makeCreatorActor(input),
          timestamp: now,
          detail: input.title,
        },
        // When importing as done, add done audit + doneAt in one shot
        ...(input.initialStatus === 'done'
          ? [
              {
                id: generateSortableId(now + 2),
                action: 'done' as const,
                actor: makeCreatorActor(input),
                timestamp: now,
                detail: 'imported as done',
              },
            ]
          : []),
      ],
      ...(input.initialStatus === 'done' ? { doneAt: now } : {}),
    };
    this.items.set(id, item);
    return item;
  }

  refreshMetadata(itemId: string, input: RefreshBacklogItemInput): BacklogItem | null {
    const existing = this.items.get(itemId);
    if (!existing) return null;

    // Status upgrade: only open→dispatched or open→done, never downgrade
    const statusUpgrade =
      input.importStatus && existing.status === 'open' && input.importStatus !== 'open'
        ? input.importStatus
        : undefined;

    const unchanged =
      existing.title === input.title &&
      existing.summary === input.summary &&
      existing.priority === input.priority &&
      this.sameTags(existing.tags, input.tags) &&
      this.sameDependencies(existing.dependencies, input.dependencies) &&
      !statusUpgrade;
    if (unchanged) return existing;

    const now = Date.now();
    const updated: BacklogItem = {
      ...existing,
      title: input.title,
      summary: input.summary,
      priority: input.priority,
      tags: [...input.tags],
      ...(input.dependencies !== undefined ? { dependencies: input.dependencies } : {}),
      ...(statusUpgrade ? { status: statusUpgrade } : {}),
      updatedAt: now,
      audit: [
        ...existing.audit,
        {
          id: generateSortableId(now + 1),
          action: 'refreshed',
          actor: makeUserActor(input.refreshedBy),
          timestamp: now,
          detail: statusUpgrade ? `docs-backlog-sync (status: ${statusUpgrade})` : 'docs-backlog-sync',
        },
      ],
    };
    this.items.set(itemId, updated);
    return updated;
  }

  get(itemId: string, userId?: string): BacklogItem | null {
    const item = this.items.get(itemId);
    if (!item) return null;
    if (userId && item.userId !== userId) return null;
    return item;
  }

  listByUser(userId: string): BacklogItem[] {
    const result: BacklogItem[] = [];
    for (const item of this.items.values()) {
      if (item.userId === userId) {
        result.push(item);
      }
    }
    result.sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id));
    return result;
  }

  suggestClaim(itemId: string, input: SuggestBacklogClaimInput): BacklogItem | null {
    const existing = this.items.get(itemId);
    if (!existing) return null;
    if (existing.status === 'suggested' && existing.suggestion?.status === 'pending') {
      if (existing.suggestion.catId === input.catId) {
        return existing;
      }
      throw new BacklogTransitionError('Invalid backlog transition: item already suggested by another cat');
    }
    if (existing.status !== 'open') {
      throw new BacklogTransitionError('Invalid backlog transition: only open items can be suggested');
    }

    const now = Date.now();
    const updated: BacklogItem = {
      ...existing,
      status: 'suggested',
      suggestion: {
        catId: input.catId,
        why: input.why,
        plan: input.plan,
        requestedPhase: input.requestedPhase,
        status: 'pending',
        suggestedAt: now,
      },
      updatedAt: now,
      audit: [
        ...existing.audit,
        {
          id: generateSortableId(now + 1),
          action: 'suggested',
          actor: makeCatActor(input.catId),
          timestamp: now,
          detail: input.plan,
        },
      ],
    };
    this.items.set(itemId, updated);
    return updated;
  }

  decideClaim(itemId: string, input: DecideBacklogClaimInput): BacklogItem | null {
    const existing = this.items.get(itemId);
    if (!existing) return null;
    if (existing.status !== 'suggested' || !existing.suggestion || existing.suggestion.status !== 'pending') {
      throw new BacklogTransitionError('Invalid backlog transition: item is not waiting for decision');
    }

    const now = Date.now();
    if (input.decision === 'reject') {
      const rejectedSuggestionBase = {
        ...existing.suggestion,
        status: 'rejected' as const,
        decidedAt: now,
        decidedBy: input.decidedBy,
      };
      const rejectedSuggestion = input.note ? { ...rejectedSuggestionBase, note: input.note } : rejectedSuggestionBase;
      const rejectAuditBase = {
        id: generateSortableId(now + 1),
        action: 'rejected' as const,
        actor: makeUserActor(input.decidedBy),
        timestamp: now,
      };
      const rejectAudit = input.note ? { ...rejectAuditBase, detail: input.note } : rejectAuditBase;
      const updated: BacklogItem = {
        ...existing,
        status: 'open',
        suggestion: rejectedSuggestion,
        updatedAt: now,
        audit: [...existing.audit, rejectAudit],
      };
      this.items.set(itemId, updated);
      return updated;
    }

    const approvedSuggestionBase = {
      ...existing.suggestion,
      status: 'approved' as const,
      decidedAt: now,
      decidedBy: input.decidedBy,
    };
    const approvedSuggestion = input.note ? { ...approvedSuggestionBase, note: input.note } : approvedSuggestionBase;
    const approveAuditBase = {
      id: generateSortableId(now + 1),
      action: 'approved' as const,
      actor: makeUserActor(input.decidedBy),
      timestamp: now,
    };
    const approveAudit = input.note ? { ...approveAuditBase, detail: input.note } : approveAuditBase;
    const updated: BacklogItem = {
      ...existing,
      status: 'approved',
      approvedAt: now,
      suggestion: approvedSuggestion,
      updatedAt: now,
      audit: [...existing.audit, approveAudit],
    };
    this.items.set(itemId, updated);
    return updated;
  }

  updateDispatchProgress(itemId: string, input: UpdateBacklogDispatchProgressInput): BacklogItem | null {
    const existing = this.items.get(itemId);
    if (!existing) return null;
    if (existing.status !== 'approved') {
      throw new BacklogTransitionError('Invalid backlog transition: dispatch progress requires approved item');
    }

    const now = Date.now();
    const updated: BacklogItem = {
      ...existing,
      ...(input.dispatchAttemptId ? { dispatchAttemptId: input.dispatchAttemptId } : {}),
      ...(input.pendingThreadId ? { pendingThreadId: input.pendingThreadId } : {}),
      ...(input.kickoffMessageId ? { kickoffMessageId: input.kickoffMessageId } : {}),
      updatedAt: now,
    };
    this.items.set(itemId, updated);
    return updated;
  }

  markDispatched(itemId: string, input: DispatchBacklogItemInput): BacklogItem | null {
    const existing = this.items.get(itemId);
    if (!existing) return null;
    if (existing.status === 'dispatched') {
      if (existing.dispatchedThreadId === input.threadId && existing.dispatchedThreadPhase === input.threadPhase) {
        return existing;
      }
      throw new BacklogTransitionError('Invalid backlog transition: item already dispatched to another thread');
    }
    if (existing.status !== 'approved') {
      throw new BacklogTransitionError('Invalid backlog transition: only approved items can be dispatched');
    }
    if ((existing.dispatchAttemptId || existing.pendingThreadId) && !existing.kickoffMessageId) {
      throw new BacklogTransitionError('Invalid backlog transition: kickoff message is required before dispatch');
    }
    if (existing.pendingThreadId && existing.pendingThreadId !== input.threadId) {
      throw new BacklogTransitionError('Invalid backlog transition: pending dispatch thread mismatch');
    }

    const now = Date.now();
    const updated: BacklogItem = {
      ...existing,
      status: 'dispatched',
      dispatchedThreadId: input.threadId,
      dispatchedThreadPhase: input.threadPhase,
      pendingThreadId: existing.pendingThreadId ?? input.threadId,
      dispatchedAt: now,
      updatedAt: now,
      audit: [
        ...existing.audit,
        {
          id: generateSortableId(now + 1),
          action: 'dispatched',
          actor: makeUserActor(input.dispatchedBy),
          timestamp: now,
          detail: `${input.threadId}:${input.threadPhase}`,
        },
      ],
    };
    this.items.set(itemId, updated);
    return updated;
  }

  acquireLease(itemId: string, input: AcquireBacklogLeaseInput): BacklogItem | null {
    const existing = this.items.get(itemId);
    if (!existing) return null;
    if (existing.status !== 'dispatched') {
      throw new BacklogTransitionError('Invalid backlog transition: only dispatched items can acquire lease');
    }

    const now = Date.now();
    const currentLease = existing.lease;
    if (this.isLeaseActive(currentLease, now) && currentLease?.ownerCatId !== input.catId) {
      throw new BacklogTransitionError('Invalid backlog transition: active lease owned by another cat');
    }

    const nextLease: BacklogLease = {
      ownerCatId: input.catId,
      state: 'active',
      acquiredAt: now,
      heartbeatAt: now,
      expiresAt: now + this.normalizeLeaseTtl(input.ttlMs),
    };

    const updated: BacklogItem = {
      ...existing,
      lease: nextLease,
      updatedAt: now,
      audit: [
        ...existing.audit,
        {
          id: generateSortableId(now + 1),
          action: 'lease_acquired',
          actor: makeUserActor(input.actorId),
          timestamp: now,
          detail: `${input.catId}:${nextLease.expiresAt}`,
        },
      ],
    };
    this.items.set(itemId, updated);
    return updated;
  }

  heartbeatLease(itemId: string, input: HeartbeatBacklogLeaseInput): BacklogItem | null {
    const existing = this.items.get(itemId);
    if (!existing) return null;
    if (existing.status !== 'dispatched') {
      throw new BacklogTransitionError('Invalid backlog transition: only dispatched items can heartbeat lease');
    }

    const now = Date.now();
    const lease = existing.lease;
    if (!lease || lease.state !== 'active') {
      throw new BacklogTransitionError('Invalid backlog transition: no active lease to heartbeat');
    }
    if (lease.ownerCatId !== input.catId) {
      throw new BacklogTransitionError('Invalid backlog transition: lease owned by another cat');
    }
    if (lease.expiresAt <= now) {
      throw new BacklogTransitionError('Invalid backlog transition: lease already expired');
    }

    const updated: BacklogItem = {
      ...existing,
      lease: {
        ...lease,
        heartbeatAt: now,
        expiresAt: now + this.normalizeLeaseTtl(input.ttlMs),
      },
      updatedAt: now,
      audit: [
        ...existing.audit,
        {
          id: generateSortableId(now + 1),
          action: 'lease_heartbeat',
          actor: makeUserActor(input.actorId),
          timestamp: now,
          detail: `${input.catId}`,
        },
      ],
    };
    this.items.set(itemId, updated);
    return updated;
  }

  releaseLease(itemId: string, input: ReleaseBacklogLeaseInput): BacklogItem | null {
    const existing = this.items.get(itemId);
    if (!existing) return null;
    if (existing.status !== 'dispatched') {
      throw new BacklogTransitionError('Invalid backlog transition: only dispatched items can release lease');
    }

    const now = Date.now();
    const lease = existing.lease;
    if (!lease || lease.state !== 'active') {
      return existing;
    }
    if (input.catId && lease.ownerCatId !== input.catId) {
      throw new BacklogTransitionError('Invalid backlog transition: lease owned by another cat');
    }

    const updated: BacklogItem = {
      ...existing,
      lease: {
        ...lease,
        state: 'released',
        releasedAt: now,
        releasedBy: input.actorId,
      },
      updatedAt: now,
      audit: [
        ...existing.audit,
        {
          id: generateSortableId(now + 1),
          action: 'lease_released',
          actor: makeUserActor(input.actorId),
          timestamp: now,
          detail: `${lease.ownerCatId}`,
        },
      ],
    };
    this.items.set(itemId, updated);
    return updated;
  }

  reclaimExpiredLease(itemId: string, input: ReclaimBacklogLeaseInput): BacklogItem | null {
    const existing = this.items.get(itemId);
    if (!existing) return null;
    if (existing.status !== 'dispatched') {
      throw new BacklogTransitionError('Invalid backlog transition: only dispatched items can reclaim lease');
    }

    const now = Date.now();
    const lease = existing.lease;
    if (!lease || lease.state !== 'active') {
      return existing;
    }
    if (lease.expiresAt > now) {
      throw new BacklogTransitionError('Invalid backlog transition: lease not expired yet');
    }

    const updated: BacklogItem = {
      ...existing,
      lease: {
        ...lease,
        state: 'reclaimed',
        reclaimedAt: now,
        reclaimedBy: input.actorId,
      },
      updatedAt: now,
      audit: [
        ...existing.audit,
        {
          id: generateSortableId(now + 1),
          action: 'lease_reclaimed',
          actor: makeUserActor(input.actorId),
          timestamp: now,
          detail: `${lease.ownerCatId}`,
        },
      ],
    };
    this.items.set(itemId, updated);
    return updated;
  }

  markDone(itemId: string, input: MarkDoneInput): BacklogItem | null {
    const existing = this.items.get(itemId);
    if (!existing) return null;
    if (existing.status === 'done') return existing;

    const now = Date.now();
    const updated: BacklogItem = {
      ...existing,
      status: 'done',
      doneAt: now,
      updatedAt: now,
      audit: [
        ...existing.audit,
        {
          id: generateSortableId(now + 1),
          action: 'done',
          actor: makeUserActor(input.doneBy),
          timestamp: now,
        },
      ],
    };
    this.items.set(itemId, updated);
    return updated;
  }

  atomicDispatch(itemId: string, input: AtomicDispatchInput): BacklogItem | null {
    const existing = this.items.get(itemId);
    if (!existing) return null;

    if (existing.status === 'dispatched') {
      if (existing.dispatchedThreadId === input.threadId && existing.dispatchedThreadPhase === input.threadPhase) {
        return existing;
      }
      throw new BacklogTransitionError('Invalid backlog transition: item already dispatched to another thread');
    }
    if (existing.status !== 'approved') {
      throw new BacklogTransitionError('Invalid backlog transition: only approved items can be atomically dispatched');
    }

    const now = Date.now();
    const updated: BacklogItem = {
      ...existing,
      status: 'dispatched',
      dispatchAttemptId: input.dispatchAttemptId,
      pendingThreadId: input.pendingThreadId,
      kickoffMessageId: input.kickoffMessageId,
      dispatchedThreadId: input.threadId,
      dispatchedThreadPhase: input.threadPhase,
      dispatchedAt: now,
      updatedAt: now,
      audit: [
        ...existing.audit,
        {
          id: generateSortableId(now + 1),
          action: 'dispatched',
          actor: makeUserActor(input.dispatchedBy),
          timestamp: now,
          detail: `${input.threadId}:${input.threadPhase}`,
        },
      ],
    };
    this.items.set(itemId, updated);
    return updated;
  }

  private evictIfNeeded(): void {
    if (this.items.size < this.maxItems) return;
    const sorted = [...this.items.values()].sort((a, b) => {
      const priorityDiff = EVICTION_PRIORITY[a.status] - EVICTION_PRIORITY[b.status];
      if (priorityDiff !== 0) return priorityDiff;
      return a.createdAt - b.createdAt || a.id.localeCompare(b.id);
    });
    const target = sorted[0];
    if (target) this.items.delete(target.id);
  }

  private sameTags(left: readonly string[], right: readonly string[]): boolean {
    if (left.length !== right.length) return false;
    const leftSorted = [...left].sort();
    const rightSorted = [...right].sort();
    for (let index = 0; index < leftSorted.length; index += 1) {
      if (leftSorted[index] !== rightSorted[index]) return false;
    }
    return true;
  }

  private sameStringArray(a: readonly string[] | undefined, b: readonly string[] | undefined): boolean {
    if (!a && !b) return true;
    if (!a || !b) return false;
    if (a.length !== b.length) return false;
    const as = [...a].sort();
    const bs = [...b].sort();
    for (let i = 0; i < as.length; i += 1) {
      if (as[i] !== bs[i]) return false;
    }
    return true;
  }

  private sameDependencies(a: BacklogDependencies | undefined, b: BacklogDependencies | undefined): boolean {
    if (!a && !b) return true;
    if (!a || !b) return false;
    return (
      this.sameStringArray(a.evolvedFrom, b.evolvedFrom) &&
      this.sameStringArray(a.blockedBy, b.blockedBy) &&
      this.sameStringArray(a.related, b.related)
    );
  }

  private normalizeLeaseTtl(ttlMs: number): number {
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) return 60_000;
    return Math.floor(ttlMs);
  }

  private isLeaseActive(lease: BacklogLease | undefined, now: number): boolean {
    return Boolean(lease && lease.state === 'active' && lease.expiresAt > now);
  }
}
