import type { RichBlock } from '@cat-cafe/shared';
import type { DraftRecord, IDraftStore } from '../../stores/ports/DraftStore.js';
import type { IInvocationRecordStore } from '../../stores/ports/InvocationRecordStore.js';
import {
  type IMessageStore,
  type LifecycleResponseTerminalPatch,
  type StoredMessage,
  type StoredToolEvent,
  settleLifecycleResponseInputs,
} from '../../stores/ports/MessageStore.js';
import type {
  ITurnExecutionStore,
  TurnExecutionRecord,
  TurnOutputFence,
  TurnOutputFenceVerdict,
} from '../../stores/ports/TurnExecutionStore.js';
import { extractRichFromText } from '../routing/rich-block-extract.js';
import { sanitizeInjectedContent } from '../routing/route-helpers.js';

/**
 * F117 KD-21: a streaming draft is the in-flight body of its response R and lives exactly as long as
 * R is processing. A path that ends a turn outside the route's own commit (stop, restart, zombie
 * reclaim, a thrown execution) settles R here: a processing R takes the draft's streamed body with
 * its terminal state, and an R that is already terminal keeps its own. Either way the inputs settle,
 * the terminal R is published, and only then is the draft deleted and the turn cleared from the
 * response-pending ledger. A rejected commit throws before any of that, so the draft and the ledger
 * entry survive for the next settlement pass.
 *
 * Whether the draft may be published at all is the turn's durable output fence, read on every pass:
 * an action-fenced turn's draft stays unpublished until its fence is allowed, and a rejected output
 * ends R empty as output_commit_rejected. No pass relies on the draft having been deleted. A turn
 * recorded before the fence existed takes the fence its parent invocation's action lease carrier
 * implies, and stays gated when that carrier cannot be read.
 */

/** The admission key of the response R a child turn owns; its draft is keyed by the same id. */
export function lifecycleResponseIdempotencyKey(invocationId: string): string {
  return `message-lifecycle-response:${invocationId}`;
}

export interface ResponseDraftSettlementDeps {
  messageStore: IMessageStore;
  draftStore?: Pick<IDraftStore, 'getByThread' | 'delete'>;
  /**
   * The turn's durable truth: its output fence decides whether the draft may be published, and its
   * response-pending ledger entry clears once R is confirmed terminal. Without it the fence cannot
   * be read, so no draft is published.
   */
  turnStore?: Pick<ITurnExecutionStore, 'get' | 'clearResponsePending'>;
  /**
   * Resolves the fence of a turn recorded before the fence existed: its parent invocation records
   * whether the dispatch carried action custody. Without it such a turn's draft is withheld.
   */
  invocationRecords?: Pick<IInvocationRecordStore, 'get'>;
  /** Publishes the terminal R to its user's live timeline. */
  emit?: (userId: string, message: StoredMessage) => void;
  /** Same failed-result/caller-wake transaction as normal execution; throws before clearing the ledger. */
  commitFailedResponse?: (response: StoredMessage, patch: LifecycleResponseTerminalPatch) => Promise<StoredMessage>;
}

export interface ResponseDraftSettlementInput {
  userId: string;
  threadId: string;
  /** The child turn id that keys both R and its draft. */
  invocationId: string;
  status: 'failed' | 'canceled' | 'interrupted';
  reason: string;
  endedAt: number;
  /** Why the turn ended, appended once after the streamed body. */
  explanation?: string;
}

/**
 * How a later settlement pass ends R: with the ended turn's own terminal truth. A turn that
 * succeeded but whose R never committed lost its delivery to the process restart.
 */
export function responseOutcomeForEndedTurn(
  turn: TurnExecutionRecord,
): Pick<ResponseDraftSettlementInput, 'status' | 'reason' | 'endedAt'> {
  const endedAt = turn.endedAt ?? turn.startedAt;
  if (turn.status === 'failed' || turn.status === 'canceled' || turn.status === 'interrupted') {
    return { status: turn.status, reason: turn.terminalReason ?? 'process_restart', endedAt };
  }
  return { status: 'interrupted', reason: 'process_restart', endedAt };
}

export type ResponseDraftSettlement =
  | { kind: 'committed' | 'already_terminal'; message: StoredMessage }
  | { kind: 'no_response' };

export async function settleResponseFromDraft(
  deps: ResponseDraftSettlementDeps,
  input: ResponseDraftSettlementInput,
): Promise<ResponseDraftSettlement> {
  const response = await deps.messageStore.getByIdempotencyKey(
    input.userId,
    input.threadId,
    lifecycleResponseIdempotencyKey(input.invocationId),
  );
  if (response?.lifecycle?.kind !== 'response') {
    // No R will ever take this draft's body. Drafts no longer expire (F117 KD-23), so it goes before
    // the turn leaves the ledger, like every other settlement.
    await deps.draftStore?.delete(input.userId, input.threadId, input.invocationId);
    await deps.turnStore?.clearResponsePending(input.invocationId);
    return { kind: 'no_response' };
  }

  const settled =
    response.lifecycle.status === 'processing'
      ? await commitFromDraft(deps, response, input)
      : { kind: 'already_terminal' as const, message: response };
  if (
    settled.kind === 'already_terminal' &&
    settled.message.lifecycle?.kind === 'response' &&
    settled.message.lifecycle.status === 'failed'
  ) {
    const recovered = await commitFailedTerminal(
      deps,
      settled.message,
      terminalPatchFromCommittedResponse(settled.message),
    );
    if (recovered.kind !== 'applied' && recovered.kind !== 'replayed') {
      throw new Error(`failed response recovery rejected: ${recovered.kind}`);
    }
    settled.message = recovered.message;
  }
  await settleLifecycleResponseInputs(deps.messageStore, settled.message, settled.message.id);
  deps.emit?.(input.userId, settled.message);
  await deps.draftStore?.delete(input.userId, input.threadId, input.invocationId);
  await deps.turnStore?.clearResponsePending(input.invocationId);
  return settled;
}

/** A durable terminal snapshot is replayed byte-for-byte, never processed as a draft. */
function terminalPatchFromCommittedResponse(response: StoredMessage): LifecycleResponseTerminalPatch {
  const lifecycle = response.lifecycle;
  if (lifecycle?.kind !== 'response' || lifecycle.status === 'processing' || lifecycle.completedAt === undefined) {
    throw new Error('response recovery requires a complete terminal snapshot');
  }
  return {
    invocationId: lifecycle.invocationId,
    status: lifecycle.status,
    completedAt: lifecycle.completedAt,
    reason: lifecycle.reason,
    content: response.content,
    contentBlocks: response.contentBlocks,
    toolEvents: response.toolEvents,
    metadata: response.metadata,
    extra: response.extra,
    thinking: response.thinking,
    origin: response.origin,
    mentions: response.mentions,
    mentionsUser: response.mentionsUser,
    replyTo: response.replyTo,
  };
}

/**
 * F117 KD-21: records the action fence's verdict on a child's output before anything commits its R,
 * so every later settlement reads the verdict rather than this process's memory. A write that fails
 * leaves the child gated, which still keeps its draft unpublished, and so does not stop the caller.
 */
export async function recordTurnOutputVerdict(
  turnStore: Pick<ITurnExecutionStore, 'settleOutputFence'> | undefined,
  invocationId: string,
  verdict: TurnOutputFenceVerdict,
  onError: (err: unknown) => void,
): Promise<void> {
  try {
    await turnStore?.settleOutputFence(invocationId, verdict);
  } catch (err) {
    onError(err);
  }
}

/**
 * F117 KD-21: records that the fence allowed a gated child's output, before the route commits its R,
 * so a settlement after a crash in between publishes the approved draft. Unlike a rejection, a write
 * that fails stops the commit: R carries a fenced body only once the turn says it may. The store is
 * required: a caller without one records no child at all and must say so where it skips this.
 */
export async function requireTurnOutputAllowed(
  turnStore: Pick<ITurnExecutionStore, 'settleOutputFence'>,
  invocationId: string,
): Promise<void> {
  const turn = await turnStore.settleOutputFence(invocationId, 'allowed');
  if (turn?.outputFence === 'allowed' || turn?.outputFence === 'open') return;
  throw new Error(
    `turn execution ${invocationId}: output fence is ${turn ? turn.outputFence : 'missing'}, not allowed`,
  );
}

type DraftDisposition = 'publish' | 'withhold' | 'reject';

/** Only an open or allowed turn may publish its draft; anything unreadable is withheld. */
async function draftDisposition(deps: ResponseDraftSettlementDeps, invocationId: string): Promise<DraftDisposition> {
  const turn = deps.turnStore ? await deps.turnStore.get(invocationId) : null;
  if (!turn) return 'withhold';
  const fence = turn.outputFence ?? (await legacyOutputFence(deps, turn));
  if (fence === 'rejected') return 'reject';
  return fence === 'open' || fence === 'allowed' ? 'publish' : 'withhold';
}

/**
 * A turn recorded before the fence existed was fenced exactly when its dispatch carried action
 * custody, which its parent invocation records. A turn that is its own parent had no dispatch to
 * fence it. When the parent cannot be read, the turn stays gated.
 */
async function legacyOutputFence(
  deps: ResponseDraftSettlementDeps,
  turn: TurnExecutionRecord,
): Promise<TurnOutputFence> {
  if (turn.parentInvocationId === turn.invocationId) return 'open';
  const parent = deps.invocationRecords ? await deps.invocationRecords.get(turn.parentInvocationId) : null;
  return parent?.actionLeaseCarrier?.kind === 'none' ? 'open' : 'gated';
}

/** Commits a processing R with its draft's body. A writer that ended R first keeps its own body. */
async function commitFromDraft(
  deps: ResponseDraftSettlementDeps,
  response: StoredMessage,
  input: ResponseDraftSettlementInput,
): Promise<{ kind: 'committed' | 'already_terminal'; message: StoredMessage }> {
  const disposition = await draftDisposition(deps, input.invocationId);
  const patch =
    disposition === 'reject'
      ? rejectedOutputPatch(response, input)
      : terminalPatchFromDraft(response, disposition === 'publish' ? await readDraft(deps, input) : undefined, input);
  const result = await commitFailedTerminal(deps, response, patch);
  if (result.kind === 'applied' || result.kind === 'replayed') return { kind: 'committed', message: result.message };
  const endedByAnotherWriter =
    result.kind === 'conflict' &&
    result.message.lifecycle?.kind === 'response' &&
    result.message.lifecycle.status !== 'processing';
  if (endedByAnotherWriter) return { kind: 'already_terminal', message: result.message };
  throw new Error(
    `response draft settlement rejected: ${result.kind}${result.kind === 'conflict' ? `:${result.reason}` : ''}`,
  );
}

async function commitFailedTerminal(
  deps: ResponseDraftSettlementDeps,
  response: StoredMessage,
  patch: LifecycleResponseTerminalPatch,
) {
  if (patch.status === 'failed') {
    if (deps.commitFailedResponse) {
      return { kind: 'replayed' as const, message: await deps.commitFailedResponse(response, patch) };
    }
    const triggerId = response.extra?.a2aFailureReturn?.triggerMessageId ?? response.replyTo;
    const trigger = triggerId ? await deps.messageStore.getById(triggerId) : null;
    if (response.extra?.a2aFailureReturn || trigger?.from?.kind === 'agent') {
      throw new Error('failed response settlement requires the caller-wake transaction');
    }
  }
  return deps.messageStore.commitLifecycleResponseTerminal(response.id, patch);
}

async function readDraft(
  deps: ResponseDraftSettlementDeps,
  input: ResponseDraftSettlementInput,
): Promise<DraftRecord | undefined> {
  if (!deps.draftStore) return undefined;
  const drafts = await deps.draftStore.getByThread(input.userId, input.threadId);
  return drafts.find((candidate) => candidate.invocationId === input.invocationId);
}

function terminalPatchFromDraft(
  response: StoredMessage,
  draft: DraftRecord | undefined,
  input: ResponseDraftSettlementInput,
): LifecycleResponseTerminalPatch {
  const streamed = streamedContent(response, draft, input.explanation);
  const toolEvents = draft?.toolEvents ? draft.toolEvents.filter(isStoredToolEvent) : response.toolEvents;
  const thinking = draft?.thinking ?? response.thinking;
  const extra = withRichBlocks(response.extra, streamed.blocks);
  const startedAt = response.lifecycle?.kind === 'response' ? response.lifecycle.startedAt : input.endedAt;
  return {
    invocationId: input.invocationId,
    status: input.status,
    completedAt: Math.max(input.endedAt, startedAt),
    reason: input.reason,
    content: streamed.content,
    ...retainedResponseFields(response),
    ...(toolEvents?.length ? { toolEvents } : {}),
    ...(extra ? { extra } : {}),
    ...(thinking ? { thinking } : {}),
  };
}

/** A rejected output ends R exactly as the route's own rejection does: empty, whatever its draft held. */
function rejectedOutputPatch(
  response: StoredMessage,
  input: ResponseDraftSettlementInput,
): LifecycleResponseTerminalPatch {
  const startedAt = response.lifecycle?.kind === 'response' ? response.lifecycle.startedAt : input.endedAt;
  return {
    invocationId: input.invocationId,
    status: 'interrupted',
    completedAt: Math.max(input.endedAt, startedAt),
    reason: 'output_commit_rejected',
    content: '',
    ...retainedResponseFields(response),
  };
}

/** The draft holds the raw streamed text; R stores it the way the route's own commit does. */
function streamedContent(
  response: StoredMessage,
  draft: DraftRecord | undefined,
  explanation: string | undefined,
): { content: string; blocks: RichBlock[] } {
  const streamed = draft
    ? extractRichFromText(sanitizeInjectedContent(draft.content))
    : { cleanText: response.content, blocks: [] };
  const body = streamed.cleanText.trim();
  const suffix = explanation && !body.includes(explanation) ? [explanation] : [];
  return { content: [body, ...suffix].filter(Boolean).join('\n\n'), blocks: streamed.blocks };
}

function withRichBlocks(extra: StoredMessage['extra'], blocks: readonly RichBlock[]): StoredMessage['extra'] {
  if (blocks.length === 0) return extra;
  return { ...extra, rich: { v: 1, blocks: [...(extra?.rich?.blocks ?? []), ...blocks] } };
}

/** R's own surfaces, restated because the terminal commit deletes every field its patch omits. */
function retainedResponseFields(response: StoredMessage) {
  return {
    ...(response.contentBlocks ? { contentBlocks: response.contentBlocks } : {}),
    ...(response.metadata ? { metadata: response.metadata } : {}),
    ...(response.origin ? { origin: response.origin } : {}),
    mentions: response.mentions,
    ...(response.mentionsUser ? { mentionsUser: true } : {}),
    ...(response.replyTo ? { replyTo: response.replyTo } : {}),
  };
}

/** Draft tool events are the route's StoredToolEvent buffer after a JSON round trip. */
function isStoredToolEvent(value: unknown): value is StoredToolEvent {
  if (!value || typeof value !== 'object') return false;
  const event = value as Record<string, unknown>;
  return (
    typeof event.id === 'string' &&
    (event.type === 'tool_use' || event.type === 'tool_result') &&
    typeof event.label === 'string' &&
    typeof event.timestamp === 'number'
  );
}
