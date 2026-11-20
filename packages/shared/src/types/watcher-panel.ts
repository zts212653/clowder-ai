import { z } from 'zod';

/**
 * F335 watcher panel ledger. One round = one settled ordinary turn seen by every panel member.
 * Member identity lives only here (owner-read); delivered messages carry the round id and labels.
 */
export const WATCHER_PANEL_LABELS = ['甲', '乙', '丙', '丁', '戊'] as const;

const id = z.string().min(1).max(300);

export const watcherPanelMemberEntrySchema = z
  .object({
    catId: id,
    /** Per-round random label; the same label is shown in the delivered message. */
    label: z.enum(WATCHER_PANEL_LABELS),
    status: z.enum(['pending', 'running', 'spoke', 'quiet', 'failed', 'interrupted']),
    /** Execution health is independent of a sentence already handed in. */
    executionStatus: z.enum(['succeeded', 'failed', 'canceled', 'interrupted']).optional(),
    /**
     * The member also works in this thread through its own ordinary session: `worker` = it did the judged
     * turn; `participant` = it has its own working history here. Not a fault, but not an independent eye.
     */
    alsoWorksHere: z.enum(['worker', 'participant']).optional(),
    invocationId: id.optional(),
    sessionId: id.optional(),
    accountRef: id.optional(),
    /** The one sentence the member handed in with cat_cafe_watcher_nudge; held until the round delivers. */
    sentence: z.string().max(1200).optional(),
    citationMessageId: id.optional(),
    /** The member cited something outside the thread or after the cutoff; the sentence is kept, the link dropped. */
    citationRejected: id.optional(),
    failure: z.string().max(500).optional(),
    /** Successful tool results this round, counted from the member's own stream. */
    actions: z
      .object({
        proposed: z.number().int().nonnegative(),
        broughtToDesk: z.number().int().nonnegative(),
        remembered: z.number().int().nonnegative(),
      })
      .strict()
      .optional(),
    context: z
      .object({
        mode: z.enum(['cold', 'hot']),
        messageCount: z.number().int().nonnegative(),
        firstMessageId: id.optional(),
        /** Older or intermediate originals were left for the member to page through itself. */
        truncated: z.boolean(),
      })
      .strict()
      .optional(),
    startedAt: z.number().int().nonnegative().optional(),
    endedAt: z.number().int().nonnegative().optional(),
  })
  .strict();

export const watcherPanelRoundSchema = z
  .object({
    v: z.literal(1),
    roundId: id,
    userId: id,
    threadId: id,
    sourceInvocationId: id,
    sourceSettledSequence: z.number().int().nonnegative(),
    /** Configuration that selected the observer; a later choice cannot release an old round's output. */
    configRevision: z.number().int().nonnegative().optional(),
    workerCatId: id,
    /** The judged turn's reply; an anchor, not the lock — a reply is created early and written until settlement. */
    cutoffMessageId: id,
    /** The lock: the judged turn's settlement time. Members read history up to here. */
    cutoffAt: z.number().int().nonnegative().optional(),
    createdAt: z.number().int().nonnegative(),
    updatedAt: z.number().int().nonnegative(),
    status: z.enum(['running', 'completed', 'interrupted', 'coalesced']),
    /** Why this round looks but never delivers. */
    quiet: z.enum(['paused', 'label_muted', 'woken_by_watcher', 'same_family']).optional(),
    /** sha256 of the guidance text the members read; the experiment fixes it before the run. */
    guidanceDigest: z.string().max(100),
    members: z.array(watcherPanelMemberEntrySchema).max(5),
    delivery: z
      .union([
        z.object({ messageId: id, targetCatId: id, deliveredAt: z.number().int().nonnegative() }).strict(),
        z
          .object({
            skipped: z.enum(['nobody_spoke', 'quiet', 'control_changed', 'target_unavailable', 'delivery_failed']),
          })
          .strict(),
      ])
      .optional(),
    /** A newer turn in the same thread was judged instead of this one. */
    coalescedInto: id.optional(),
  })
  .strict();

export type WatcherPanelMemberEntry = z.infer<typeof watcherPanelMemberEntrySchema>;
export type WatcherPanelRound = z.infer<typeof watcherPanelRoundSchema>;

/** Where the woken worker answered, resolved at read time from the execution ledger. */
export interface WatcherPanelResponseRef {
  invocationId: string;
  responseMessageId?: string;
  settledAt?: number;
}

export interface WatcherPanelResponseRefs {
  /** The worker turn that received the delivered message. */
  woken?: WatcherPanelResponseRef & {
    /** trigger: the delivery woke it; after_delivery: a busy worker received it with its next turn. */
    matchedBy: 'trigger' | 'after_delivery';
  };
  /** The worker's next ordinary turn after that one. */
  next?: WatcherPanelResponseRef;
}

export interface WatcherPanelRoundView extends WatcherPanelRound {
  responses?: WatcherPanelResponseRefs;
}

/** Blind export for the evaluator: no member identity, invocation, session or account. */
export interface WatcherPanelBlindRound {
  roundId: string;
  threadId: string;
  workerCatId: string;
  cutoffMessageId: string;
  cutoffAt?: number;
  createdAt: number;
  status: WatcherPanelRound['status'];
  quiet?: WatcherPanelRound['quiet'];
  delivery?: WatcherPanelRound['delivery'];
  members: Array<
    Pick<
      WatcherPanelMemberEntry,
      | 'label'
      | 'status'
      | 'executionStatus'
      | 'alsoWorksHere'
      | 'sentence'
      | 'citationMessageId'
      | 'citationRejected'
      | 'failure'
      | 'actions'
      | 'context'
    >
  >;
  responses?: WatcherPanelResponseRefs;
}

export function blindWatcherPanelRound(round: WatcherPanelRoundView): WatcherPanelBlindRound {
  return {
    roundId: round.roundId,
    threadId: round.threadId,
    workerCatId: round.workerCatId,
    cutoffMessageId: round.cutoffMessageId,
    ...(round.cutoffAt !== undefined ? { cutoffAt: round.cutoffAt } : {}),
    createdAt: round.createdAt,
    status: round.status,
    ...(round.quiet ? { quiet: round.quiet } : {}),
    ...(round.delivery ? { delivery: round.delivery } : {}),
    members: [...round.members]
      .sort((left, right) => left.label.localeCompare(right.label, 'zh-Hans-CN'))
      .map((member) => ({
        label: member.label,
        status: member.status,
        ...(member.executionStatus ? { executionStatus: member.executionStatus } : {}),
        ...(member.alsoWorksHere ? { alsoWorksHere: member.alsoWorksHere } : {}),
        ...(member.sentence ? { sentence: member.sentence } : {}),
        ...(member.citationMessageId ? { citationMessageId: member.citationMessageId } : {}),
        ...(member.citationRejected ? { citationRejected: member.citationRejected } : {}),
        ...(member.failure ? { failure: member.failure } : {}),
        ...(member.actions ? { actions: member.actions } : {}),
        ...(member.context ? { context: member.context } : {}),
      })),
    ...(round.responses ? { responses: round.responses } : {}),
  };
}
