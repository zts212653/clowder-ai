import type { GlobalArtifactDTO } from '@cat-cafe/shared';
import { projectRecentWorks } from '@cat-cafe/shared/recent-works';
import type { BoundedOwnerMessagePage, IMessageStore, StoredMessage } from '../../stores/ports/MessageStore.js';
import { getTimelineOrderTime } from '../../stores/visibility.js';
import { projectRecentMessageArtifactPage } from './thread-artifacts-aggregator.js';

const SCAN_PAGE_SIZE = 64;
const SCAN_MESSAGE_LIMIT = 512;
const SCAN_ARTIFACT_LIMIT = 512;

/** Invalidate on material publications, not streamed prose or thinking. Admission stays in the original projector. */
export function hasRecentWorkPublication(message: StoredMessage): boolean {
  return projectRecentMessageArtifactPage(message, 1).artifacts.length > 0;
}

export interface RecentGlobalWorkScanResult {
  artifacts: GlobalArtifactDTO[];
  messages: readonly StoredMessage[];
  complete: boolean;
  scannedMessages: number;
}

function projectPage(
  messages: readonly StoredMessage[],
  threadTitles: ReadonlyMap<string, string>,
  limit: number,
): { artifacts: GlobalArtifactDTO[]; complete: boolean } {
  let artifacts: GlobalArtifactDTO[] = [];
  let total = 0;
  for (const message of messages) {
    const threadTitle = threadTitles.get(message.threadId);
    if (!threadTitle) continue;
    const page = projectRecentMessageArtifactPage(message, limit);
    total += page.total;
    artifacts = projectRecentWorks(
      [...artifacts, ...page.artifacts.map((artifact) => ({ ...artifact, threadId: message.threadId, threadTitle }))],
      'unavailable',
      limit,
    );
  }
  return { artifacts, complete: total <= limit };
}

function canonicalMessagesAtBoundary(
  messages: readonly StoredMessage[],
  page: BoundedOwnerMessagePage,
): readonly StoredMessage[] {
  if (page.oldestTimelineGroupComplete || !page.nextCursor) return messages;
  const unsafeTimestamp = page.nextCursor.timestamp;
  return messages.filter((message) => getTimelineOrderTime(message) !== unsafeTimestamp);
}

function isValidBoundedPage(page: BoundedOwnerMessagePage, readLimit: number): boolean {
  if (page.scannedCount < 0 || page.scannedCount > readLimit) return false;
  if (page.exhausted) return page.oldestTimelineGroupComplete;
  return page.nextCursor !== undefined;
}

function cursorAdvanced(
  page: BoundedOwnerMessagePage,
  cursorTime: number,
  cursorId: string | undefined,
): page is BoundedOwnerMessagePage & { nextCursor: { timestamp: number; id: string } } {
  if (!page.nextCursor) return false;
  return page.nextCursor.timestamp !== cursorTime || page.nextCursor.id !== cursorId;
}

function finishScan(input: {
  messages: readonly StoredMessage[];
  boundaryPage: BoundedOwnerMessagePage | undefined;
  threadTitles: ReadonlyMap<string, string>;
  artifactLimit: number;
  messageComplete: boolean;
  scannedMessages: number;
}): RecentGlobalWorkScanResult {
  const canonicalMessages = input.boundaryPage
    ? canonicalMessagesAtBoundary(input.messages, input.boundaryPage)
    : input.messages;
  const projection = projectPage(canonicalMessages, input.threadTitles, input.artifactLimit);
  return {
    artifacts: projection.artifacts,
    messages: canonicalMessages,
    complete: input.messageComplete && projection.complete,
    scannedMessages: input.scannedMessages,
  };
}

/**
 * F232 KD-9: scan the owner-global timeline newest-first, never every thread's
 * complete history. Because work families are only known after one F309 batch,
 * the reader scans to exhaustion or the raw ceiling before applying an
 * independent artifact ceiling. No N×overscan can prove N distinct families.
 */
export async function collectRecentGlobalWorkCandidates(input: {
  store: Pick<IMessageStore, 'getOwnerBeforeBounded'>;
  userId: string;
  threadTitles: ReadonlyMap<string, string>;
  limit: number;
  pageSize?: number;
  messageLimit?: number;
  artifactLimit?: number;
}): Promise<RecentGlobalWorkScanResult> {
  const pageSize = Math.max(1, Math.floor(input.pageSize ?? SCAN_PAGE_SIZE));
  const messageLimit = Math.max(1, Math.floor(input.messageLimit ?? SCAN_MESSAGE_LIMIT));
  const artifactLimit = Math.min(
    SCAN_ARTIFACT_LIMIT,
    Math.max(input.limit, Math.floor(input.artifactLimit ?? SCAN_ARTIFACT_LIMIT)),
  );
  const scannedVisibleMessages: StoredMessage[] = [];
  let scannedMessages = 0;
  let cursorTime = Number.MAX_SAFE_INTEGER;
  let cursorId: string | undefined;
  let boundaryPage: BoundedOwnerMessagePage | undefined;
  let messageComplete = false;

  while (scannedMessages < messageLimit) {
    const readLimit = Math.min(pageSize, messageLimit - scannedMessages);
    const page = await input.store.getOwnerBeforeBounded(input.userId, cursorTime, readLimit, cursorId, readLimit, {
      includeQueuedCatMessages: true,
    });
    if (!isValidBoundedPage(page, readLimit)) {
      break;
    }
    scannedMessages += page.scannedCount;
    scannedVisibleMessages.push(...page.messages);
    boundaryPage = page;
    if (page.exhausted) {
      messageComplete = true;
      break;
    }

    if (!cursorAdvanced(page, cursorTime, cursorId)) {
      break;
    }
    cursorTime = page.nextCursor.timestamp;
    cursorId = page.nextCursor.id;
  }

  return finishScan({
    messages: scannedVisibleMessages,
    boundaryPage,
    threadTitles: input.threadTitles,
    artifactLimit,
    messageComplete,
    scannedMessages,
  });
}
