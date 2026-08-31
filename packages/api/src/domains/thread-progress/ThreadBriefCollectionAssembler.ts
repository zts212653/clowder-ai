import type { ThreadBriefCollectionV1, ThreadBriefV1 } from '@cat-cafe/shared';
import type { IThreadStore, Thread } from '../cats/services/stores/ports/ThreadStore.js';
import type { ThreadBriefAssembler, ThreadBriefCurrentFacts } from './ThreadBriefAssembler.js';
import type { IThreadProgressReceiptStore } from './ThreadProgressReceiptStore.js';

export interface ThreadBriefCollectionAssemblerDeps {
  readonly threadStore: Pick<IThreadStore, 'get'>;
  readonly receiptStore: Pick<IThreadProgressReceiptStore, 'listRecentThreads'>;
  readonly briefAssembler: ThreadBriefAssembler;
  readonly discoverCurrentFacts: (ownerUserId: string) => Promise<ReadonlyMap<string, ThreadBriefCurrentFacts>>;
  readonly now?: () => number;
}

export class ThreadBriefCollectionAssembler {
  constructor(private readonly deps: ThreadBriefCollectionAssemblerDeps) {}

  async assemble(
    ownerUserId: string,
    options: { readonly limit: number; readonly cursor?: string },
  ): Promise<ThreadBriefCollectionV1> {
    const currentFacts = await this.deps.discoverCurrentFacts(ownerUserId);
    const current = (
      await Promise.all(
        [...currentFacts.entries()].map(([threadId, facts]) => this.assembleOwned(threadId, ownerUserId, facts)),
      )
    )
      .filter((brief): brief is ThreadBriefV1 => brief !== null)
      .sort(compareCurrentBriefs);
    const currentIds = new Set(current.map((brief) => brief.thread.id));
    const recentPage = await this.deps.receiptStore.listRecentThreads(ownerUserId, {
      limit: options.limit,
      cursor: options.cursor,
      excludeThreadIds: currentIds,
    });
    const emptyCurrentFacts: ThreadBriefCurrentFacts = { live: [], attention: [], waits: [] };
    const recent = (
      await Promise.all(
        recentPage.items.map((item) => this.assembleOwned(item.threadId, ownerUserId, emptyCurrentFacts)),
      )
    ).filter((brief): brief is ThreadBriefV1 => brief !== null);

    return {
      v: 1,
      current,
      recent,
      nextCursor: recentPage.nextCursor,
      generatedAt: this.deps.now?.() ?? Date.now(),
    };
  }

  private async assembleOwned(
    threadId: string,
    ownerUserId: string,
    currentFacts: ThreadBriefCurrentFacts,
  ): Promise<ThreadBriefV1 | null> {
    try {
      const thread = await this.deps.threadStore.get(threadId);
      if (!isOwnedOrdinaryThread(thread, ownerUserId)) return null;
      return this.deps.briefAssembler.assemble(thread, ownerUserId, currentFacts);
    } catch {
      return null;
    }
  }
}

function isOwnedOrdinaryThread(thread: Thread | null, ownerUserId: string): thread is Thread {
  return Boolean(
    thread &&
      thread.createdBy === ownerUserId &&
      !thread.deletedAt &&
      !thread.systemKind &&
      !thread.threadKind &&
      !thread.externalRuntimeAnchorState,
  );
}

function compareCurrentBriefs(left: ThreadBriefV1, right: ThreadBriefV1): number {
  const leftKey = currentSortKey(left);
  const rightKey = currentSortKey(right);
  return leftKey.rank - rightKey.rank || leftKey.time - rightKey.time || left.thread.id.localeCompare(right.thread.id);
}

function currentSortKey(brief: ThreadBriefV1): { rank: number; time: number } {
  if (brief.presentationState === 'needs_user') {
    return { rank: 0, time: Math.min(...brief.attention.map((item) => item.createdAt)) };
  }
  if (brief.presentationState === 'running') {
    return { rank: 1, time: -Math.max(...brief.currentExecutions.map((item) => item.startedAt)) };
  }
  if (brief.presentationState === 'unknown') {
    const starts = brief.currentExecutions.map((item) => item.startedAt);
    return { rank: 2, time: starts.length > 0 ? -Math.max(...starts) : brief.generatedAt };
  }
  if (brief.presentationState === 'waiting_external') {
    return { rank: 3, time: Math.min(...brief.waits.map((item) => item.wakeAt ?? item.createdAt)) };
  }
  return { rank: 4, time: brief.generatedAt };
}
