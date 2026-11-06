import { z } from 'zod';
import { workReferenceSchema } from './work-reference.js';

/**
 * F335 交付三：桌面猫带来。东西本身只在「给人的东西」里存一份（带来的作品挂在带作品卡的那条消息上）；这里是它在
 * 桌面上的投递状态，和 Host 拿到 / 回传的有界形状。Host 只回传 展示 / 打开 / 添加 / 忽略 / 没理，不落第二份内容。
 */

/** Shown on the desktop over other apps: no control characters or bidi overrides. */
function safeForDesk(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f || (code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069)) {
      return false;
    }
  }
  return true;
}

/** Server-side projection of text that came from elsewhere (work titles, thread titles) into a desk-safe line. */
export function toDeskText(value: string, max: number): string {
  let out = '';
  for (const char of value.trim()) {
    const next = safeForDesk(char) ? char : char === '\n' || char === '\t' ? ' ' : '';
    if (out.length + next.length > max) return `${out.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
    out += next;
  }
  return out.trim();
}

const text = (max: number) => z.string().trim().min(1).max(max).refine(safeForDesk, 'no control characters');

export const suggestionDeskWorkSchema = z
  .object({
    ...workReferenceSchema.shape,
    /** Read from the work card on the message when the desk shows it; absent until then. */
    title: text(200).optional(),
  })
  .strict();
export type SuggestionDeskWork = z.infer<typeof suggestionDeskWorkSchema>;

/** pending: not yet on the desk · shown: the bubble is up · settled: the person (or the countdown) decided. */
export const suggestionDeskStatusSchema = z.enum(['pending', 'shown', 'settled']);
export type SuggestionDeskStatus = z.infer<typeof suggestionDeskStatusSchema>;

/** saved = the countdown ran out unanswered; the thing stays in its conversation (「已保存到对话」). */
export const suggestionDeskOutcomeSchema = z.enum(['opened', 'added', 'dismissed', 'saved']);
export type SuggestionDeskOutcome = z.infer<typeof suggestionDeskOutcomeSchema>;

export const suggestionDeskViewSchema = z
  .object({
    /** The bubble's one sentence: 「鲸鲸那三格，照他的头像画就行。」 Brought works only. */
    sentence: text(120).optional(),
    work: suggestionDeskWorkSchema.optional(),
    status: suggestionDeskStatusSchema,
    outcome: suggestionDeskOutcomeSchema.optional(),
    shownAt: z.number().int().nonnegative().optional(),
    settledAt: z.number().int().nonnegative().optional(),
  })
  .strict();
export type SuggestionDeskView = z.infer<typeof suggestionDeskViewSchema>;

/** `cat_cafe_bring_to_desk`: the work is already saved and its card is on that message (`cat_cafe_work`). */
export const bringToDeskInputSchema = z
  .object({
    /** The message carrying the work card; defaults to the caller's own reply in this turn. */
    messageId: z.string().trim().min(1).max(200).optional(),
    sentence: text(120),
    work: workReferenceSchema,
  })
  .strict();
export type BringToDeskInput = z.infer<typeof bringToDeskInputSchema>;

/** One line on the desk. `ref` + `revision` are the only handle the Host passes back. */
export const deskDeliveryItemSchema = z
  .object({
    ref: z.string().min(1).max(200),
    revision: z.number().int().nonnegative(),
    kind: z.enum(['work', 'suggestion']),
    catId: z.string().min(1).max(120),
    byline: z.enum(['cat', 'watcher']),
    /** Work title, or the suggestion's button text (「添加 7 条视频批注」). */
    title: text(200),
    sentence: text(120).optional(),
    work: suggestionDeskWorkSchema.optional(),
    /** 出自哪条对话. */
    threadId: z.string().min(1).max(200),
    threadTitle: text(120).optional(),
    action: z.enum(['open', 'add']),
    createdAt: z.number().int().nonnegative(),
  })
  .strict();
export type DeskDeliveryItem = z.infer<typeof deskDeliveryItemSchema>;

/** single: the person is at the desk and one thing arrived · bundle: they came back and these were waiting. */
export const deskDeliveryModeSchema = z.enum(['single', 'bundle']);
export type DeskDeliveryMode = z.infer<typeof deskDeliveryModeSchema>;

export const deskSettleActionSchema = z.enum(['shown', 'open', 'add', 'dismiss', 'timeout']);
export type DeskSettleAction = z.infer<typeof deskSettleActionSchema>;

export const deskSettleInputSchema = z
  .object({
    action: deskSettleActionSchema,
    items: z
      .array(z.object({ ref: z.string().min(1).max(200), revision: z.number().int().nonnegative() }).strict())
      .min(1)
      .max(20),
  })
  .strict();
export type DeskSettleInput = z.infer<typeof deskSettleInputSchema>;

/** What the desk gets back when it asks: newest first, at most `DESK_DELIVERY_LIMIT`; `more` were left for Clowder AI. */
export const DESK_DELIVERY_LIMIT = 8;
export const deskDeliverySchema = z
  .object({
    mode: deskDeliveryModeSchema,
    items: z.array(deskDeliveryItemSchema).min(1).max(DESK_DELIVERY_LIMIT),
    more: z.number().int().nonnegative(),
  })
  .strict();
export type DeskDelivery = z.infer<typeof deskDeliverySchema>;

/** stale: that line changed elsewhere (clicked in the page, expired) — drop it from the desk, nothing was done. */
export const deskSettleItemResultSchema = z
  .object({
    ref: z.string().min(1).max(200),
    revision: z.number().int().nonnegative(),
    outcome: z.enum(['settled', 'stale', 'failed']),
    code: z.string().max(40).optional(),
  })
  .strict();
export type DeskSettleItemResult = z.infer<typeof deskSettleItemResultSchema>;

export const deskSettlementSchema = z
  .object({
    action: deskSettleActionSchema,
    items: z.array(deskSettleItemResultSchema).max(20),
    /** 「已保存到对话」: only after a countdown ran out on something that is in its conversation. */
    saved: z.boolean().optional(),
    /** `open`: where the work is, for the Host to bring Clowder AI forward on it. */
    open: z
      .object({
        threadId: z.string().min(1).max(200),
        messageId: z.string().min(1).max(200),
        work: workReferenceSchema,
      })
      .strict()
      .optional(),
  })
  .strict();
export type DeskSettlement = z.infer<typeof deskSettlementSchema>;
