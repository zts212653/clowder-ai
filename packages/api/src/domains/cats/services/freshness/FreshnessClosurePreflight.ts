import type { FreshnessClosureAggregate } from '@cat-cafe/shared';
import { compareCursors, cursorFor, parseCursor } from '../stores/cursor.js';
import type { IMessageStore, StoredMessage } from '../stores/ports/MessageStore.js';
import type { ITurnExecutionStore, TurnExecutionRecord } from '../stores/ports/TurnExecutionStore.js';
import { isExpectedA2AReplyForCat, isFreshnessRoutableMessage } from './checkFreshnessForPostMessage.js';
import { decideFreshnessRelevance } from './FreshnessRelevancePolicy.js';
import { isFreshnessSelfSourceMessage } from './FreshnessSourcePolicy.js';
import { recordFreshnessRelevanceSuppression } from './freshness-relevance-telemetry.js';

const PAGE_SIZE = 20;
const MAX_PAGES = 500;

export type FreshnessClosurePreflightResult =
  | {
      kind: 'ready';
      originMessage: StoredMessage;
      requiredMessages: StoredMessage[];
      requiredMessageIds: string[];
      requiredFrontierMessageId: string;
      observedRawFrontierMessageId: string;
    }
  | { kind: 'blocked'; evidenceRefs: string[] };

type BlockedPreflight = Extract<FreshnessClosurePreflightResult, { kind: 'blocked' }>;
type LoadedFrontiers = {
  kind: 'loaded';
  latestRawFrontier: string;
  latestVisibleCursor: string;
  latestVisibleMessageId: string;
};

function blocked(...evidenceRefs: string[]): BlockedPreflight {
  return { kind: 'blocked', evidenceRefs };
}

async function loadClosureBodies(input: {
  closure: FreshnessClosureAggregate;
  messageStore: IMessageStore;
}): Promise<
  { kind: 'loaded'; originMessage: StoredMessage; requiredById: Map<string, StoredMessage> } | BlockedPreflight
> {
  const { closure, messageStore } = input;
  if (!closure.originTriggerMessageId) return blocked('origin-trigger:missing-identity');
  const originMessage = await messageStore.getById(closure.originTriggerMessageId);
  if (!originMessage) return blocked(`missing-origin-message:${closure.originTriggerMessageId}`);

  const pairs = await Promise.all(
    closure.requiredMessageIds.map(async (id) => [id, await messageStore.getById(id)] as const),
  );
  const missingIds = pairs.filter((pair) => pair[1] === null).map((pair) => pair[0]);
  if (missingIds.length > 0) {
    return blocked(...missingIds.map((id) => `missing-required-message:${id}`));
  }
  const requiredById = new Map<string, StoredMessage>();
  for (const [id, message] of pairs) {
    if (message) requiredById.set(id, message);
  }
  return { kind: 'loaded', originMessage, requiredById };
}

async function isCurrentRelevantMessage(
  message: StoredMessage,
  closure: FreshnessClosureAggregate,
  messageStore: IMessageStore,
  coveredTriggerMessageIds: ReadonlySet<string>,
): Promise<boolean> {
  if (!isFreshnessRoutableMessage(message) || isFreshnessSelfSourceMessage(message, closure.catId, closure.threadId)) {
    return false;
  }
  const relevance = decideFreshnessRelevance(message, { catId: closure.catId, coveredTriggerMessageIds });
  if (!relevance.relevant) {
    recordFreshnessRelevanceSuppression(relevance.reason);
    return false;
  }
  return !(await isExpectedA2AReplyForCat(message, closure.catId, messageStore));
}

async function inspectVisibilityBatch(input: {
  batch: readonly StoredMessage[];
  closure: FreshnessClosureAggregate;
  messageStore: IMessageStore;
  latestRawFrontier: string;
  latestVisibleCursor: string;
  requiredById: Map<string, StoredMessage>;
  coveredTriggerMessageIds: ReadonlySet<string>;
}): Promise<{ reachedVisibilitySnapshot: boolean; nextCursor?: string }> {
  let nextCursor: string | undefined;
  for (const message of input.batch) {
    const messageCursor = cursorFor(message);
    if (compareCursors(messageCursor, input.latestVisibleCursor) > 0) {
      return { reachedVisibilitySnapshot: true, nextCursor };
    }
    nextCursor = messageCursor;
    // The raw frontier is the append snapshot. A message appended after that
    // snapshot must not leak into this preflight even if it entered the same
    // visibility page; a late-visible older raw ID is still in scope.
    if (message.id <= input.latestRawFrontier) {
      const relevant = await isCurrentRelevantMessage(
        message,
        input.closure,
        input.messageStore,
        input.coveredTriggerMessageIds,
      );
      if (relevant) input.requiredById.set(message.id, message);
    }
    if (messageCursor === input.latestVisibleCursor) {
      return { reachedVisibilitySnapshot: true, nextCursor };
    }
  }
  return { reachedVisibilitySnapshot: false, nextCursor };
}

async function scanRawFrontier(input: {
  closure: FreshnessClosureAggregate;
  messageStore: IMessageStore;
  latestRawFrontier: string;
  latestVisibleCursor: string;
  latestVisibleMessageId: string;
  requiredById: Map<string, StoredMessage>;
  coveredTriggerMessageIds: ReadonlySet<string>;
}): Promise<{ kind: 'scanned'; rawCursor: string } | BlockedPreflight> {
  const {
    closure,
    messageStore,
    latestRawFrontier,
    latestVisibleCursor,
    latestVisibleMessageId,
    requiredById,
    coveredTriggerMessageIds,
  } = input;
  const previousRawFrontier = closure.observedRawFrontierMessageId ?? closure.requiredFrontierMessageId;
  if (latestRawFrontier < previousRawFrontier) {
    return blocked(`raw-frontier:regressed:${latestRawFrontier}:${previousRawFrontier}`);
  }

  // Raw frontier and visibility frontier are intentionally distinct. A queued
  // message can become visible after previousRawFrontier without creating a new
  // raw ID, so the visibility snapshot decides whether the scan is complete.
  // We still return the sampled raw frontier for ADR-041's append boundary.
  const previousRawId = parseCursor(previousRawFrontier)?.id ?? previousRawFrontier;
  if (previousRawFrontier === latestRawFrontier && previousRawId === latestVisibleMessageId) {
    return { kind: 'scanned', rawCursor: latestRawFrontier };
  }

  let paginationCursor = previousRawFrontier;
  const visitedCursors = new Set([paginationCursor]);
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const batch = await messageStore.getByThreadAfter(closure.threadId, paginationCursor, PAGE_SIZE, closure.userId, {
      includeQueuedCatMessages: true,
    });
    if (batch.length === 0) break;

    const inspected = await inspectVisibilityBatch({
      batch,
      closure,
      messageStore,
      latestRawFrontier,
      latestVisibleCursor,
      requiredById,
      coveredTriggerMessageIds,
    });

    if (inspected.reachedVisibilitySnapshot) return { kind: 'scanned', rawCursor: latestRawFrontier };
    if (!inspected.nextCursor || visitedCursors.has(inspected.nextCursor)) {
      return blocked(`raw-frontier:non-advancing:${previousRawFrontier}`);
    }
    paginationCursor = inspected.nextCursor;
    visitedCursors.add(inspected.nextCursor);
  }
  return blocked(`raw-frontier:incomplete:${previousRawFrontier}:${latestRawFrontier}`);
}

function buildReadyResult(input: {
  originMessage: StoredMessage;
  requiredById: Map<string, StoredMessage>;
  rawCursor: string;
}): FreshnessClosurePreflightResult {
  const requiredMessageIds = [...input.requiredById.keys()].sort();
  const requiredFrontierMessageId = requiredMessageIds.at(-1);
  if (!requiredFrontierMessageId) return blocked('required-frontier:empty');
  const requiredMessages: StoredMessage[] = [];
  for (const id of requiredMessageIds) {
    const message = input.requiredById.get(id);
    if (!message) return blocked(`missing-required-message:${id}`);
    requiredMessages.push(message);
  }
  return {
    kind: 'ready',
    originMessage: input.originMessage,
    requiredMessages,
    requiredMessageIds,
    requiredFrontierMessageId,
    observedRawFrontierMessageId: input.rawCursor,
  };
}

async function loadCoveredTriggerMessageIds(
  closure: FreshnessClosureAggregate,
  turnExecutionStore?: Pick<ITurnExecutionStore, 'get'>,
): Promise<{ kind: 'loaded'; ids: Set<string> } | BlockedPreflight> {
  const ids = new Set<string>();
  if (!turnExecutionStore) return { kind: 'loaded', ids };

  let execution: TurnExecutionRecord | null;
  try {
    execution = await turnExecutionStore.get(closure.turnInvocationId);
  } catch {
    return blocked(`turn-execution:unreadable:${closure.turnInvocationId}`);
  }
  if (
    execution &&
    (execution.threadId !== closure.threadId ||
      execution.userId !== closure.userId ||
      execution.catId !== closure.catId)
  ) {
    return blocked(`turn-execution:scope-mismatch:${closure.turnInvocationId}`);
  }
  for (const messageId of execution?.causal?.coveredMessageIds ?? []) ids.add(messageId);
  return { kind: 'loaded', ids };
}

async function loadCurrentFrontiers(
  closure: FreshnessClosureAggregate,
  messageStore: IMessageStore,
): Promise<LoadedFrontiers | BlockedPreflight> {
  const latestRawFrontier = await messageStore.getLatestThreadMessageIdIncludingQueued(closure.threadId);
  if (!latestRawFrontier) return blocked('raw-frontier:missing');

  if (messageStore.canonicalizeCursor) {
    const canonicalRawFrontier = await messageStore.canonicalizeCursor(latestRawFrontier, closure.threadId);
    if (canonicalRawFrontier === latestRawFrontier) {
      const previousRawFrontier = closure.observedRawFrontierMessageId ?? closure.requiredFrontierMessageId;
      return blocked(`raw-frontier:incomplete:${previousRawFrontier}:${latestRawFrontier}`);
    }
  }
  const latestVisible = messageStore.getLatestVisibleCursor
    ? await messageStore.getLatestVisibleCursor(closure.threadId)
    : { cursor: latestRawFrontier, messageId: latestRawFrontier };
  if (!latestVisible) return blocked('visibility-frontier:missing');
  return {
    kind: 'loaded',
    latestRawFrontier,
    latestVisibleCursor: latestVisible.cursor,
    latestVisibleMessageId: latestVisible.messageId,
  };
}

/**
 * Rebuild closure input from current MessageStore truth before a retry may claim
 * the single running lease. This is deliberately fail-closed: an incomplete raw
 * scan must never turn a two-hour-old prompt into apparent current user intent.
 */
export async function scanFreshnessClosurePreflight(input: {
  closure: FreshnessClosureAggregate;
  messageStore: IMessageStore;
  turnExecutionStore?: Pick<ITurnExecutionStore, 'get'>;
}): Promise<FreshnessClosurePreflightResult> {
  const { closure, messageStore, turnExecutionStore } = input;
  const loaded = await loadClosureBodies(input);
  if (loaded.kind === 'blocked') return loaded;
  const covered = await loadCoveredTriggerMessageIds(closure, turnExecutionStore);
  if (covered.kind === 'blocked') return covered;
  const frontiers = await loadCurrentFrontiers(closure, messageStore);
  if (frontiers.kind === 'blocked') return frontiers;
  const scanned = await scanRawFrontier({
    closure,
    messageStore,
    latestRawFrontier: frontiers.latestRawFrontier,
    latestVisibleCursor: frontiers.latestVisibleCursor,
    latestVisibleMessageId: frontiers.latestVisibleMessageId,
    requiredById: loaded.requiredById,
    coveredTriggerMessageIds: covered.ids,
  });
  if (scanned.kind === 'blocked') return scanned;
  return buildReadyResult({ ...loaded, rawCursor: scanned.rawCursor });
}
