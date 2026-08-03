import type { FreshnessClosureAggregate } from '@cat-cafe/shared';
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

async function scanRawFrontier(input: {
  closure: FreshnessClosureAggregate;
  messageStore: IMessageStore;
  latestRawFrontier: string;
  requiredById: Map<string, StoredMessage>;
  coveredTriggerMessageIds: ReadonlySet<string>;
}): Promise<{ kind: 'scanned'; rawCursor: string } | BlockedPreflight> {
  const { closure, messageStore, latestRawFrontier, requiredById, coveredTriggerMessageIds } = input;
  let rawCursor = closure.observedRawFrontierMessageId ?? closure.requiredFrontierMessageId;
  if (latestRawFrontier < rawCursor) {
    return blocked(`raw-frontier:regressed:${latestRawFrontier}:${rawCursor}`);
  }

  for (let page = 0; rawCursor < latestRawFrontier && page < MAX_PAGES; page += 1) {
    const batch = await messageStore.getByThreadAfter(closure.threadId, rawCursor, PAGE_SIZE, closure.userId);
    const nextCursor = batch.at(-1)?.id;
    if (!nextCursor) break;
    if (nextCursor <= rawCursor) return blocked(`raw-frontier:non-advancing:${rawCursor}`);
    for (const message of batch) {
      if (await isCurrentRelevantMessage(message, closure, messageStore, coveredTriggerMessageIds)) {
        requiredById.set(message.id, message);
      }
    }
    rawCursor = nextCursor;
  }
  return rawCursor >= latestRawFrontier
    ? { kind: 'scanned', rawCursor }
    : blocked(`raw-frontier:incomplete:${rawCursor}:${latestRawFrontier}`);
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
  const coveredTriggerMessageIds = new Set<string>();
  if (turnExecutionStore) {
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
    for (const messageId of execution?.causal?.coveredMessageIds ?? []) {
      coveredTriggerMessageIds.add(messageId);
    }
  }
  const latestRawFrontier = await messageStore.getLatestThreadMessageIdIncludingQueued(closure.threadId);
  if (!latestRawFrontier) return blocked('raw-frontier:missing');
  const scanned = await scanRawFrontier({
    closure,
    messageStore,
    latestRawFrontier,
    requiredById: loaded.requiredById,
    coveredTriggerMessageIds,
  });
  if (scanned.kind === 'blocked') return scanned;
  return buildReadyResult({ ...loaded, rawCursor: scanned.rawCursor });
}
