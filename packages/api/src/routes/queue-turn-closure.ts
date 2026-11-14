/**
 * How a stop or repair outside the QueueProcessor ends a cat's turn (PR-3 contract §2.3).
 *
 * Order is the contract, taken from `failUncontrollableInvocation`:
 *   1. the exact child turns: those of the parent run for this thread, owner and cat, plus the
 *      explicit child the caller holds. R is keyed by its child turn id, never by the parent run;
 *   2. each child's terminal is written first, which enters it in the response-pending ledger
 *      atomically (F117 KD-21). A child that had already ended keeps its own terminal;
 *   3. then each child's response R settles from its draft, with the terminal its turn record
 *      holds after step 2 — the one written here, or the earlier one it kept. A child the turn
 *      store does not know takes the closure's terminal for an R that exists exactly for it. The
 *      terminal commit never overwrites: an R another writer already ended keeps that writer's
 *      terminal, and its snapshot is published as it is. A settlement that throws is left for a
 *      recovery retry; the caller decides how to surface the throw.
 *
 * Nothing is written while a live route will still commit one of these R
 * (`ResponseProducerRegistry`), or while the caller says the run may still produce it
 * (`producerMayRemain`). The child turn's ending alone says nothing about R: a route ends its turn
 * before it commits R.
 *
 * Settling R publishes `message_lifecycle_updated` to the owner's user room through `emit`, so a
 * client that no longer listens to the thread room still learns the turn ended.
 */
import type {
  ResponseDraftSettlementDeps,
  ResponseDraftSettlementInput,
} from '../domains/cats/services/agents/invocation/response-draft-settlement.js';
import {
  responseOutcomeForEndedTurn,
  settleResponseFromDraft,
} from '../domains/cats/services/agents/invocation/response-draft-settlement.js';
import {
  type ResponseProducerRegistry,
  responseProducers,
} from '../domains/cats/services/agents/invocation/response-producer-registry.js';
import type { IDraftStore } from '../domains/cats/services/stores/ports/DraftStore.js';
import type { IInvocationRecordStore } from '../domains/cats/services/stores/ports/InvocationRecordStore.js';
import type { IMessageStore, StoredMessage } from '../domains/cats/services/stores/ports/MessageStore.js';
import type {
  ITurnExecutionStore,
  TransitionTurnExecutionResult,
} from '../domains/cats/services/stores/ports/TurnExecutionStore.js';

/** The reasons the stop paths end a turn with: a user Stop, and force-reset. */
export const STOP_RESPONSE_REASON = { userStop: 'user_cancel', forceReset: 'cancel_all' } as const;

export interface ExecutionTurnClosureDeps {
  /** Without it no R can be read or committed; only the child turns end. */
  messageStore?: IMessageStore;
  draftStore?: IDraftStore;
  turnExecutionStore?: Pick<
    ITurnExecutionStore,
    'get' | 'listByParent' | 'transitionTerminal' | 'clearResponsePending'
  >;
  invocationRecordStore?: Pick<IInvocationRecordStore, 'get'>;
  /** The failed-result/caller-wake transaction, also used to replay an R another writer failed. */
  commitFailedResponse: NonNullable<ResponseDraftSettlementDeps['commitFailedResponse']>;
  emit: (userId: string, message: StoredMessage) => void;
  /** The routes' live R claims; the process-wide registry unless a test supplies its own. */
  responseProducers?: Pick<ResponseProducerRegistry, 'has'>;
}

export interface ExecutionTurnClosureInput {
  threadId: string;
  /** The run's owner: the user R belongs to, whose room hears its terminal. */
  userId: string;
  catId: string;
  /** The parent run id. */
  executionId: string;
  /** The exact child turn the caller holds, if any. */
  invocationId?: string;
  status: Extract<ResponseDraftSettlementInput['status'], 'failed' | 'canceled'>;
  reason: string;
  endedAt: number;
  /** Appended once after the streamed body of a turn this closure ends. */
  explanation?: string;
  /**
   * Only a caller that proved the provider tree exited may set this. While a producer still holds
   * the run, that proof is the one thing recorded: on the explicit child, and nowhere else.
   */
  providerTeardownAt?: number;
  /**
   * Whether the run may still produce R by evidence the registry does not cover (see
   * `runMayStillProduce` in queue.ts). Read only when there is a child and no route claims one.
   */
  producerMayRemain?: () => boolean | Promise<boolean>;
  /**
   * Without it the first R that cannot settle throws. With it each failure is reported and the
   * other turns still settle.
   */
  onSettlementError?: (invocationId: string, err: unknown) => void;
}

export interface ExecutionTurnClosure {
  /** Child turns whose R this closure settled (or tried to): their ending is durable. */
  closedInvocationIds: readonly string[];
  /** Of those, the ids the turn store does not know: no pending record would retry their R. */
  unknownInvocationIds: readonly string[];
  /** Ids whose R settlement threw. */
  unsettledInvocationIds: readonly string[];
  /** Some R of these turns is terminal now, whoever ended it. */
  responseTerminalized: boolean;
  /** A producer still holds the run: no R was settled and no turn ended but the proven one. */
  deferredToProducer: boolean;
}

type ResponseTerminal = Pick<ResponseDraftSettlementInput, 'status' | 'reason' | 'endedAt' | 'explanation'>;

export async function closeExecutionChildTurns(
  deps: ExecutionTurnClosureDeps,
  input: ExecutionTurnClosureInput,
): Promise<ExecutionTurnClosure> {
  const turns = deps.turnExecutionStore;
  const children = turns
    ? (await turns.listByParent(input.executionId)).filter(
        (child) => child.threadId === input.threadId && child.userId === input.userId && child.catId === input.catId,
      )
    : [];
  const explicit = input.invocationId ? [input.invocationId] : [];
  const allChildren = [...new Set([...explicit, ...children.map((child) => child.invocationId)])];
  const deferredToProducer = await producerStillHolds(deps, input, allChildren);
  if (deferredToProducer) {
    if (input.providerTeardownAt !== undefined) {
      for (const invocationId of explicit) await transitionChild(turns, invocationId, input);
    }
    return {
      closedInvocationIds: [],
      unknownInvocationIds: [],
      unsettledInvocationIds: [],
      responseTerminalized: false,
      deferredToProducer,
    };
  }

  const settleable: Array<{ invocationId: string; terminal: ResponseTerminal }> = [];
  const unknownInvocationIds: string[] = [];
  for (const invocationId of allChildren) {
    const after = responseTerminalAfter(await transitionChild(turns, invocationId, input), input);
    if (!after) continue;
    settleable.push({ invocationId, terminal: after.terminal });
    if (after.unknown) unknownInvocationIds.push(invocationId);
  }

  const settled = deps.messageStore
    ? await settleChildResponses({ ...deps, messageStore: deps.messageStore }, input, settleable)
    : { responseTerminalized: false, unsettledInvocationIds: [] };
  return {
    closedInvocationIds: settleable.map(({ invocationId }) => invocationId),
    unknownInvocationIds,
    ...settled,
    deferredToProducer,
  };
}

/** A live route claims one of these R, or the caller's own evidence says the run may produce it. */
async function producerStillHolds(
  deps: ExecutionTurnClosureDeps,
  input: ExecutionTurnClosureInput,
  children: readonly string[],
): Promise<boolean> {
  if (children.length === 0) return false;
  const producers = deps.responseProducers ?? responseProducers;
  if (children.some((invocationId) => producers.has(invocationId))) return true;
  return input.producerMayRemain !== undefined && (await input.producerMayRemain());
}

function transitionChild(
  turns: ExecutionTurnClosureDeps['turnExecutionStore'],
  invocationId: string,
  input: ExecutionTurnClosureInput,
): Promise<TransitionTurnExecutionResult | undefined> {
  return Promise.resolve(
    turns?.transitionTerminal(invocationId, {
      status: input.status,
      endedAt: input.endedAt,
      terminalReason: input.reason,
      ...(input.providerTeardownAt !== undefined ? { providerTeardownAt: input.providerTeardownAt } : {}),
    }),
  );
}

/**
 * What R takes from its turn once the transition has run (no route claims it any more):
 * - a turn this closure ended: the closure's terminal;
 * - a turn that had already ended: that ending, with its reason (`responseOutcomeForEndedTurn`, the
 *   recovery rule); the explanation belongs only to an ending this closure wrote;
 * - a turn the store does not know: the closure's terminal, for an R that exists exactly for it.
 *   `settleResponseFromDraft` finds R by its exact owner/thread/turn key and withholds the draft,
 *   whose fence no turn record can vouch for; without such an R there is nothing to settle;
 * - a turn whose ending cannot be read: nothing.
 */
function responseTerminalAfter(
  transition: TransitionTurnExecutionResult | undefined,
  input: ExecutionTurnClosureInput,
): { terminal: ResponseTerminal; unknown: boolean } | null {
  const written: ResponseTerminal = {
    status: input.status,
    reason: input.reason,
    endedAt: input.endedAt,
    ...(input.explanation ? { explanation: input.explanation } : {}),
  };
  // No turn store: there is no durable turn truth to defer to (tests and legacy wiring).
  if (!transition || transition.outcome === 'transitioned') return { terminal: written, unknown: false };
  if (transition.outcome === 'not_found') return { terminal: written, unknown: true };
  if (!transition.record) return null;
  const kept = responseOutcomeForEndedTurn(transition.record);
  // An earlier attempt of this same closure wrote that ending; it keeps its explanation.
  const ownEnding = kept.status === input.status && kept.reason === input.reason;
  return {
    terminal: ownEnding && input.explanation ? { ...kept, explanation: input.explanation } : kept,
    unknown: false,
  };
}

/** Settles each child's R in turn. */
async function settleChildResponses(
  deps: ExecutionTurnClosureDeps & { messageStore: IMessageStore },
  input: ExecutionTurnClosureInput,
  settleable: ReadonlyArray<{ invocationId: string; terminal: ResponseTerminal }>,
): Promise<{ responseTerminalized: boolean; unsettledInvocationIds: string[] }> {
  const settlementDeps: ResponseDraftSettlementDeps = {
    messageStore: deps.messageStore,
    ...(deps.draftStore ? { draftStore: deps.draftStore } : {}),
    ...(deps.turnExecutionStore ? { turnStore: deps.turnExecutionStore } : {}),
    ...(deps.invocationRecordStore ? { invocationRecords: deps.invocationRecordStore } : {}),
    commitFailedResponse: deps.commitFailedResponse,
    emit: deps.emit,
  };
  let responseTerminalized = false;
  const unsettledInvocationIds: string[] = [];
  for (const { invocationId, terminal } of settleable) {
    try {
      // KD-21: R carries what the turn had streamed, then the draft goes.
      const settlement = await settleResponseFromDraft(settlementDeps, {
        userId: input.userId,
        threadId: input.threadId,
        invocationId,
        ...terminal,
      });
      if (settlement.kind !== 'no_response') responseTerminalized = true;
    } catch (err) {
      if (!input.onSettlementError) throw err;
      unsettledInvocationIds.push(invocationId);
      input.onSettlementError(invocationId, err);
    }
  }
  return { responseTerminalized, unsettledInvocationIds };
}
