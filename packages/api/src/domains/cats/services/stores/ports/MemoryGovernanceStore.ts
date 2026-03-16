/**
 * Memory Governance Store
 * 治理状态机: draft → pending_review → published → archived
 *
 * Phase 5.0 Step 2a: 发布门禁
 * - 首版内存 Map 实现，接口预留 Redis
 * - 状态迁移是纯函数可测
 * - 不做 24h 自动提醒（铲屎官决策）
 */

export type GovernanceStatus = 'draft' | 'pending_review' | 'published' | 'archived';
export type PublishAction = 'submit_review' | 'approve' | 'archive' | 'rollback';

export interface GovernanceEntry {
  readonly entryId: string;
  readonly status: GovernanceStatus;
  readonly updatedBy: string;
  readonly updatedAt: number;
  readonly anchors?: string[];
}

export interface IMemoryGovernanceStore {
  create(entryId: string, actor: string, anchors?: string[]): GovernanceEntry;
  transition(entryId: string, action: PublishAction, actor: string): GovernanceEntry;
  get(entryId: string): GovernanceEntry | null;
  list(): GovernanceEntry[];
}

/** Valid state transitions: [fromStatus, action] → toStatus */
const TRANSITIONS: Record<string, GovernanceStatus | undefined> = {
  'draft:submit_review': 'pending_review',
  'pending_review:approve': 'published',
  'published:archive': 'archived',
  'published:rollback': 'draft',
};

/**
 * Resolve the next status for a given transition.
 * Throws a descriptive error (409-style) if the transition is invalid.
 */
export function resolveTransition(currentStatus: GovernanceStatus, action: PublishAction): GovernanceStatus {
  const key = `${currentStatus}:${action}`;
  const next = TRANSITIONS[key];
  if (!next) {
    throw new GovernanceConflictError(
      `Invalid transition: cannot ${action} from ${currentStatus}`,
      currentStatus,
      action,
    );
  }
  return next;
}

export class GovernanceConflictError extends Error {
  readonly currentStatus: GovernanceStatus;
  readonly action: PublishAction;

  constructor(message: string, currentStatus: GovernanceStatus, action: PublishAction) {
    super(message);
    this.name = 'GovernanceConflictError';
    this.currentStatus = currentStatus;
    this.action = action;
  }
}

/**
 * In-memory governance store.
 * First version — will be replaced with Redis-backed store later.
 */
export class MemoryGovernanceStore implements IMemoryGovernanceStore {
  private readonly entries = new Map<string, GovernanceEntry>();

  create(entryId: string, actor: string, anchors?: string[]): GovernanceEntry {
    const existing = this.entries.get(entryId);
    if (existing) {
      throw new GovernanceConflictError(`Entry ${entryId} already exists`, existing.status, 'submit_review');
    }

    const entry: GovernanceEntry = {
      entryId,
      status: 'draft',
      updatedBy: actor,
      updatedAt: Date.now(),
      ...(anchors ? { anchors } : {}),
    };

    this.entries.set(entryId, entry);
    return entry;
  }

  transition(entryId: string, action: PublishAction, actor: string): GovernanceEntry {
    const existing = this.entries.get(entryId);
    if (!existing) {
      throw new GovernanceConflictError(`Entry ${entryId} not found`, 'draft', action);
    }

    const nextStatus = resolveTransition(existing.status, action);

    const updated: GovernanceEntry = {
      ...existing,
      status: nextStatus,
      updatedBy: actor,
      updatedAt: Date.now(),
    };

    this.entries.set(entryId, updated);
    return updated;
  }

  get(entryId: string): GovernanceEntry | null {
    return this.entries.get(entryId) ?? null;
  }

  list(): GovernanceEntry[] {
    return [...this.entries.values()];
  }
}
