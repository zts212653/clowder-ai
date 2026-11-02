import type { GlobalArtifactDTO, GlobalArtifactsResponse, ThreadArtifactDTO } from '@cat-cafe/shared';
import { projectRecentWorks } from '@cat-cafe/shared/recent-works';
import { collectRecentGlobalWorkCandidates } from '../domains/cats/services/agents/routing/recent-global-work-reader.js';
import type { IMessageStore, StoredMessage } from '../domains/cats/services/stores/ports/MessageStore.js';
import type { IThreadStore } from '../domains/cats/services/stores/ports/ThreadStore.js';
import {
  type IndependentWorkCataloguePort,
  withIndependentWorksRead,
} from '../domains/collaborative-content/works/catalogue.js';

/** The homepage combines bounded sources; a per-thread traversal prefix proves no global latest frontier. */
export async function readRecentWorksView(input: {
  userId: string;
  limit: number;
  threadStore: IThreadStore;
  messageStore: IMessageStore | undefined;
  independent: IndependentWorkCataloguePort | undefined;
  resolveLineage(artifacts: GlobalArtifactDTO[]): Promise<Pick<GlobalArtifactsResponse, 'artifacts' | 'workLineage'>>;
  readAccepted(
    threadId: string,
    messages: readonly StoredMessage[],
  ): Promise<{ artifacts: ThreadArtifactDTO[]; complete: boolean }>;
}): Promise<GlobalArtifactsResponse & { complete: boolean }> {
  const threads = (await input.threadStore.list(input.userId)).filter(
    (thread) => thread.createdBy === input.userId || thread.createdBy === 'system',
  );
  const threadTitles = new Map(threads.map((thread) => [thread.id, thread.title ?? thread.id]));
  const scan = await (async () => {
    if (input.messageStore) {
      try {
        return await collectRecentGlobalWorkCandidates({
          store: input.messageStore,
          userId: input.userId,
          threadTitles,
          limit: input.limit,
        });
      } catch {
        /* An unavailable source cannot certify empty history. Other original sources remain useful. */
      }
    }
    return { artifacts: [], messages: [], complete: false };
  })();
  const accepted: GlobalArtifactDTO[] = [];
  let acceptedComplete = true;
  // Receipts come from the same bounded raw scan, never another complete thread walk.
  const receiptThreads = new Set(
    scan.messages
      .filter((message) => message.extra?.systemKind === 'content_modification_receipt')
      .map((message) => message.threadId),
  );
  for (const threadId of receiptThreads) {
    const threadTitle = threadTitles.get(threadId);
    if (threadTitle === undefined) continue;
    const result = await input.readAccepted(
      threadId,
      scan.messages.filter((message) => message.threadId === threadId),
    );
    acceptedComplete &&= result.complete;
    accepted.push(...result.artifacts.map((artifact) => ({ ...artifact, threadId, threadTitle })));
  }
  const project = async (owned: readonly GlobalArtifactDTO[], independentComplete: boolean) => {
    const candidates = [...scan.artifacts, ...accepted, ...owned];
    const bounded = projectRecentWorks(candidates, 'unavailable', 512);
    const projected = await input.resolveLineage(bounded);
    const artifacts = projectRecentWorks(projected.artifacts, projected.workLineage, input.limit);
    return {
      artifacts,
      total: artifacts.length,
      workLineage: projected.workLineage,
      complete:
        scan.complete &&
        acceptedComplete &&
        independentComplete &&
        candidates.length <= 512 &&
        (projected.artifacts.length === 0 || projected.workLineage === 'resolved'),
    };
  };
  try {
    // Includes lineage projection: final canonical manifest/authorization validation happens before HTTP return.
    return await withIndependentWorksRead(input.independent, input.userId, async (reader) => {
      if (!reader?.readRecent) return project([], false);
      const owned = await reader.readRecent({ ownerUserId: input.userId, threadTitles, limit: input.limit });
      return project(owned.artifacts, owned.complete);
    });
  } catch {
    // Discard the failed owner snapshot, retaining only independently readable message/accepted cards.
    return project([], false);
  }
}
