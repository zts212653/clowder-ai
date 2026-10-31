import type { GlobalArtifactDTO } from '@cat-cafe/shared';
import type { IMessageStore } from '../../../cats/services/stores/ports/MessageStore.js';
import type { GlobalArtifactWorkLineageResolverPort } from '../../../video-studio/content-owner/global-artifact-work-lineage.js';
import { readCompanionArtifactLineage } from './companion-work-lineage.js';
import { companionMessagePublications } from './companion-work-publications.js';

const THREAD_BUDGET = 16;
const MESSAGES_PER_THREAD = 32;
const PUBLICATION_BUDGET = 64;

/** A bounded current-project observation, not F232's complete global library or newest-prefix contract. */
export async function readCompanionProjectArtifacts(options: {
  ownerUserId: string;
  threadIds: ReadonlySet<string>;
  messages: Pick<IMessageStore, 'getByThread'>;
  lineage?: GlobalArtifactWorkLineageResolverPort;
}) {
  let complete = options.threadIds.size <= THREAD_BUDGET;
  const artifacts: GlobalArtifactDTO[] = [];
  for (const threadId of [...options.threadIds].slice(0, THREAD_BUDGET)) {
    try {
      const window = await options.messages.getByThread(threadId, MESSAGES_PER_THREAD + 1, options.ownerUserId, {
        includeQueuedCatMessages: true,
      });
      if (window.length > MESSAGES_PER_THREAD) complete = false;
      artifacts.push(
        ...window
          .slice(-MESSAGES_PER_THREAD)
          .flatMap((message) => companionMessagePublications(message, options.ownerUserId, threadId)),
      );
    } catch {
      complete = false;
    }
  }
  artifacts.sort(
    (a, b) =>
      b.createdAt - a.createdAt ||
      a.threadId.localeCompare(b.threadId) ||
      (a.sourceMessageId ?? '').localeCompare(b.sourceMessageId ?? ''),
  );
  if (artifacts.length > PUBLICATION_BUDGET) complete = false;
  const selected = artifacts.slice(0, PUBLICATION_BUDGET);
  return readCompanionArtifactLineage(options, selected, complete);
}
