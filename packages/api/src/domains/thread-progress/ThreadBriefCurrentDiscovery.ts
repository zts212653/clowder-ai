import type { ThreadBriefAttentionItem, ThreadBriefWaitItem } from '@cat-cafe/shared';
import type { ThreadBriefCurrentFacts, ThreadBriefLiveExecution } from './ThreadBriefAssembler.js';

export interface ThreadScopedAttention {
  readonly threadId: string;
  readonly item: ThreadBriefAttentionItem;
}

export interface ThreadScopedWait {
  readonly threadId: string;
  readonly item: ThreadBriefWaitItem;
}

export interface ThreadBriefCurrentDiscoveryDeps {
  readonly listRunningThreadIds: (ownerUserId: string) => Promise<readonly string[]>;
  readonly listAttention: (ownerUserId: string) => Promise<readonly ThreadScopedAttention[]>;
  readonly listWaits: (ownerUserId: string) => Promise<readonly ThreadScopedWait[]>;
  readonly readLiveExecutions: (threadId: string, ownerUserId: string) => Promise<readonly ThreadBriefLiveExecution[]>;
}

interface MutableCurrentFacts {
  live: readonly ThreadBriefLiveExecution[] | null;
  attention: ThreadBriefAttentionItem[];
  waits: ThreadBriefWaitItem[];
}

/** Discovers only owner-scoped current candidates, then resolves canonical liveness for that small set. */
export class ThreadBriefCurrentDiscovery {
  constructor(private readonly deps: ThreadBriefCurrentDiscoveryDeps) {}

  async discover(ownerUserId: string): Promise<ReadonlyMap<string, ThreadBriefCurrentFacts>> {
    const [runningThreadIds, attentionEntries, waitEntries] = await Promise.all([
      this.deps.listRunningThreadIds(ownerUserId),
      this.deps.listAttention(ownerUserId),
      this.deps.listWaits(ownerUserId),
    ]);
    const facts = new Map<string, MutableCurrentFacts>();
    const ensure = (threadId: string) => {
      const existing = facts.get(threadId);
      if (existing) return existing;
      const created: MutableCurrentFacts = { live: [], attention: [], waits: [] };
      facts.set(threadId, created);
      return created;
    };

    for (const entry of attentionEntries) ensure(entry.threadId).attention.push(entry.item);
    for (const entry of waitEntries) ensure(entry.threadId).waits.push(entry.item);

    const liveThreadIds = [...new Set(runningThreadIds)];
    await Promise.all(
      liveThreadIds.map(async (threadId) => {
        const target = ensure(threadId);
        try {
          target.live = await this.deps.readLiveExecutions(threadId, ownerUserId);
        } catch {
          target.live = null;
        }
      }),
    );

    for (const threadId of liveThreadIds) {
      const value = facts.get(threadId);
      if (value?.live?.length === 0 && value.attention.length === 0 && value.waits.length === 0) {
        facts.delete(threadId);
      }
    }
    return facts;
  }
}
