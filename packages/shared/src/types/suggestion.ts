import { z } from 'zod';

/**
 * F335 交付二：回话下面那一排——一键提议与原地回执（「给人的东西」）。
 *
 * 任何猫都能在一条消息下面挂一个提议（一点就用、一点就撤、× 忽略），或者一行回执（已经做了的事，可撤销 / 恢复）。
 * 一条消息下面最多一行。人的处置——用了 / 改了 / 撤销 / 忽略 / 不理——按种类累计成事实给猫自己掂量；
 * 不写死「几次就不再提」（F335 KD-11）。猫决定不再提的种类，人在「设置 › 你 › 已隐藏的建议」恢复。
 */

/** A suggestion kind is the action it performs (`video-comments`, `scheduled-task`, …); the server registry owns the set. */
export const suggestionKindSchema = z
  .string()
  .trim()
  .regex(/^[a-z][a-z0-9-]{1,47}$/);
export type SuggestionKind = z.infer<typeof suggestionKindSchema>;

/**
 * - `open`: the pill is showing.
 * - `applying` / `undoing`: a click is being carried out; the row is inert until it settles.
 * - `applied`: the receipt row (「已添加 7 条批注 › · 撤销」).
 * - `dismissed`: 「已忽略 · 撤销」.
 * - `undone`: a receipt the cat posted directly was undone (an undone *offer* goes back to `open`).
 * - `ignored`: nobody acted before it expired; the row is gone.
 */
export const suggestionStateSchema = z.enum([
  'open',
  'applying',
  'applied',
  'undoing',
  'dismissed',
  'undone',
  'ignored',
]);
export type SuggestionState = z.infer<typeof suggestionStateSchema>;

/** What the human did with it, recorded in order. `restored` = undid a dismissal. */
export const suggestionEventTypeSchema = z.enum([
  'offered',
  'receipted',
  'applied',
  'undone',
  'dismissed',
  'restored',
  'ignored',
  'edited',
]);
export type SuggestionEventType = z.infer<typeof suggestionEventTypeSchema>;

/** How the undo control on an applied row reads: 撤销 (undo) or 恢复 (resume, e.g. after a pause). */
export const suggestionUndoLabelSchema = z.enum(['undo', 'resume']);
export type SuggestionUndoLabel = z.infer<typeof suggestionUndoLabelSchema>;

/** Who is speaking on the row. `watcher` draws the eye badge on the avatar (F335 4a 标识). */
export const suggestionBylineSchema = z.enum(['cat', 'watcher']);
export type SuggestionByline = z.infer<typeof suggestionBylineSchema>;

/** Where a receipt's › goes: the work in 作品模式, or a Workspace mode (调度 for scheduled tasks). */
export const suggestionOpenTargetSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('work'),
      contentRef: z.string().min(1).max(500),
      ownerRevision: z.number().int().positive(),
      title: z.string().min(1).max(200),
    })
    .strict(),
  z.object({ kind: z.literal('workspace-mode'), mode: z.literal('schedule') }).strict(),
]);
export type SuggestionOpenTarget = z.infer<typeof suggestionOpenTargetSchema>;

export const suggestionReceiptViewSchema = z
  .object({
    text: z.string().min(1).max(80),
    open: suggestionOpenTargetSchema.optional(),
  })
  .strict();
export type SuggestionReceiptView = z.infer<typeof suggestionReceiptViewSchema>;

/** A click that never settled (process killed mid-apply) stops blocking its row after this long. */
export const SUGGESTION_STALE_TRANSITION_MS = 2 * 60_000;

/**
 * When a row next changes on its own — the pill expires as 「不理」, or a stuck click frees up — so an open page knows
 * when to read it again. null when it only changes by someone acting on it.
 */
export function suggestionNextSelfChangeAt(row: {
  state: string;
  expiresAt: number;
  updatedAt: number;
}): number | null {
  if (row.state === 'open') return row.expiresAt;
  if (row.state === 'applying' || row.state === 'undoing') return row.updatedAt + SUGGESTION_STALE_TRANSITION_MS;
  return null;
}

/** The row as the web draws it. Action params and applied references stay on the server. */
export const suggestionViewSchema = z
  .object({
    id: z.string().min(1),
    threadId: z.string().min(1),
    messageId: z.string().min(1),
    catId: z.string().min(1),
    byline: suggestionBylineSchema,
    kind: suggestionKindSchema,
    kindLabel: z.string().min(1).max(40),
    /** The pill text, e.g. 「添加 7 条视频批注」. */
    label: z.string().min(1).max(40),
    state: suggestionStateSchema,
    receipt: suggestionReceiptViewSchema.optional(),
    watcherSupplement: z
      .object({ catId: z.string().min(1), text: z.string().min(1).max(80) })
      .strict()
      .optional(),
    /** null when this row cannot be undone. */
    undo: suggestionUndoLabelSchema.nullable(),
    /** True when the row came straight in as a receipt (no pill before it). */
    receiptOnly: z.boolean(),
    revision: z.number().int().nonnegative(),
    createdAt: z.number().int().nonnegative(),
    updatedAt: z.number().int().nonnegative(),
    expiresAt: z.number().int().nonnegative(),
  })
  .strict();
export type SuggestionView = z.infer<typeof suggestionViewSchema>;

export const threadSuggestionsResponseSchema = z
  .object({ threadId: z.string().min(1), suggestions: z.array(suggestionViewSchema) })
  .strict();
export type ThreadSuggestionsResponse = z.infer<typeof threadSuggestionsResponseSchema>;

/** Socket `suggestion_updated` payload, broadcast to `thread:<threadId>`. */
export const suggestionUpdatedEventSchema = z
  .object({ threadId: z.string().min(1), suggestion: suggestionViewSchema })
  .strict();
export type SuggestionUpdatedEvent = z.infer<typeof suggestionUpdatedEventSchema>;

/** Human click on a row; `expectedRevision` fences double clicks and stale tabs. */
export const suggestionDecisionBodySchema = z.object({ expectedRevision: z.number().int().nonnegative() }).strict();
export type SuggestionDecisionBody = z.infer<typeof suggestionDecisionBodySchema>;

const MAX_EXPIRY_MINUTES = 7 * 24 * 60;
export const DEFAULT_SUGGESTION_EXPIRY_MINUTES = 24 * 60;

/** A cat offers one prepared action under a message (`cat_cafe_offer_suggestion`). */
export const suggestionOfferInputSchema = z
  .object({
    /** The message the row hangs under; defaults to the caller's own reply in this turn. */
    messageId: z.string().trim().min(1).max(200).optional(),
    label: z.string().trim().min(1).max(40),
    action: z
      .object({
        kind: suggestionKindSchema,
        params: z.record(z.string(), z.unknown()),
      })
      .strict(),
    expiresInMinutes: z.number().int().min(5).max(MAX_EXPIRY_MINUTES).optional(),
  })
  .strict();
export type SuggestionOfferInput = z.infer<typeof suggestionOfferInputSchema>;

/** A cat already did something and leaves one line under a message (`cat_cafe_post_action_receipt`). */
export const suggestionReceiptInputSchema = z
  .object({
    messageId: z.string().trim().min(1).max(200).optional(),
    text: z.string().trim().min(1).max(60),
    /** What the undo control reverses; omit for a receipt that cannot be undone. */
    action: z
      .object({
        kind: suggestionKindSchema,
        appliedRef: z.record(z.string(), z.unknown()),
      })
      .strict()
      .optional(),
  })
  .strict();
export type SuggestionReceiptInput = z.infer<typeof suggestionReceiptInputSchema>;

export const suggestionKindRecentSchema = z
  .object({
    at: z.number().int().nonnegative(),
    label: z.string(),
    threadId: z.string(),
    outcome: suggestionStateSchema,
    edited: z.boolean(),
  })
  .strict();

/** Per-kind facts the cat weighs before offering again. Counts are facts, never a rule. */
export const suggestionKindFactsSchema = z
  .object({
    kind: suggestionKindSchema,
    kindLabel: z.string(),
    offered: z.number().int().nonnegative(),
    applied: z.number().int().nonnegative(),
    edited: z.number().int().nonnegative(),
    undone: z.number().int().nonnegative(),
    dismissed: z.number().int().nonnegative(),
    ignored: z.number().int().nonnegative(),
    open: z.number().int().nonnegative(),
    lastOfferedAt: z.number().int().nonnegative().optional(),
    /** Present when the asking cat stopped offering this kind (and the human has not restored it). */
    stoppedAt: z.number().int().nonnegative().optional(),
    recent: z.array(suggestionKindRecentSchema),
  })
  .strict();
export type SuggestionKindFacts = z.infer<typeof suggestionKindFactsSchema>;

export const suggestionFactsQuerySchema = z
  .object({
    kind: suggestionKindSchema.optional(),
    /** The asking cat decides not to offer this kind again; the human can restore it in 设置 › 你. */
    stopOffering: suggestionKindSchema.optional(),
  })
  .strict();
export type SuggestionFactsQuery = z.infer<typeof suggestionFactsQuerySchema>;

export const hiddenSuggestionKindSchema = z
  .object({
    catId: z.string().min(1),
    byline: suggestionBylineSchema,
    kind: suggestionKindSchema,
    kindLabel: z.string(),
    hiddenAt: z.number().int().nonnegative(),
  })
  .strict();
export type HiddenSuggestionKind = z.infer<typeof hiddenSuggestionKindSchema>;

export const hiddenSuggestionKindsResponseSchema = z.object({ hidden: z.array(hiddenSuggestionKindSchema) }).strict();
export type HiddenSuggestionKindsResponse = z.infer<typeof hiddenSuggestionKindsResponseSchema>;

export const restoreSuggestionKindBodySchema = z
  .object({ catId: z.string().trim().min(1).max(120), kind: suggestionKindSchema })
  .strict();
export type RestoreSuggestionKindBody = z.infer<typeof restoreSuggestionKindBodySchema>;
