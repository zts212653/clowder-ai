import { suggestionFactsQuerySchema, suggestionOfferInputSchema, suggestionReceiptInputSchema } from '@cat-cafe/shared';
import { z } from 'zod';
import { defineMcpCanonicalFactory } from '../tool-governance-migration.js';
import { callbackPost } from './callback-tools.js';
import type { ToolResult } from './file-tools.js';

const defineTool = defineMcpCanonicalFactory('suggestion-tools.ts', undefined, {
  resourceFamily: 'artifact-surface',
  authority: 'callback-thread',
});

/** 「给人的东西」 is its own resource (F335 交付二); its entry is accepted in the F335 feature doc. */
const admission = {
  disposition: 'accepted-boundary',
  kind: 'resource-entry',
  admissionRef: 'file:docs/features/F335-watcher-cat.md',
} as const;

const messageId = z
  .string()
  .min(1)
  .max(200)
  .optional()
  .describe(
    'The message the row hangs under, in this conversation. Omit to hang it under your own reply in this turn.',
  );

export const offerSuggestionInputSchema = {
  messageId,
  label: z
    .string()
    .min(1)
    .max(40)
    .describe('The button text: verb + object, e.g. 「添加 7 条视频批注」「创建定时任务 · 每周一 9:00」.'),
  action: z
    .object({
      kind: z.string().describe('video-comments | scheduled-task'),
      params: z
        .record(z.string(), z.unknown())
        .describe(
          'video-comments: {contentRef, ownerRevision, title, comments:[{atSeconds, endSeconds?, text}] (1–12)} on a Works video. ' +
            'scheduled-task: {templateId, trigger, params?, label?, category?, description?} — the same fields as register_scheduled_task, as objects; it delivers to this conversation.',
        ),
    })
    .strict()
    .describe('The prepared action. It runs only when the person taps.'),
  expiresInMinutes: z
    .number()
    .int()
    .min(5)
    .max(7 * 24 * 60)
    .optional()
    .describe('Default 24h. Unanswered by then, the row leaves and counts as 不理.'),
};

export const postActionReceiptInputSchema = {
  messageId,
  text: z.string().min(1).max(60).describe('What was done, as a receipt: 「已向小星星补了一条先例」.'),
  action: z
    .object({
      kind: z.string().describe('scheduled-task'),
      appliedRef: z.record(z.string(), z.unknown()).describe('scheduled-task: {taskId} of a task you registered here.'),
    })
    .strict()
    .optional()
    .describe('Give the row an undo. Omit for a receipt that cannot be undone.'),
};

export const suggestionFactsInputSchema = {
  kind: z.string().optional().describe('One kind; omit for every kind.'),
  stopOffering: z
    .string()
    .optional()
    .describe('A kind you decide not to offer again. The person can restore it in 设置 › 你 › 已隐藏的建议.'),
};

export async function handleOfferSuggestion(input: unknown): Promise<ToolResult> {
  return callbackPost('/api/callbacks/suggestions', suggestionOfferInputSchema.parse(input));
}

export async function handlePostActionReceipt(input: unknown): Promise<ToolResult> {
  return callbackPost('/api/callbacks/suggestion-receipts', suggestionReceiptInputSchema.parse(input));
}

export async function handleSuggestionFacts(input: unknown): Promise<ToolResult> {
  return callbackPost('/api/callbacks/suggestion-facts', suggestionFactsQuerySchema.parse(input ?? {}));
}

export const suggestionTools = [
  defineTool({
    name: 'cat_cafe_offer_suggestion',
    description:
      'Put one prepared, reversible action under a message as a button the person taps once (「一键提议」). ' +
      'Use when: there is one small thing nobody asked for that the person may want, it only touches their own things, and you can prepare it completely now — e.g. their screenshots of a film turned into timed video comments, a recurring request turned into a scheduled task. ' +
      'Not for: decisions, spending, starting new conversations, changing how a cat works, or touching someone else’s things (use a proposal card); repeating what the reply already offers. ' +
      'Output: the row; tapping runs the action, shows an undoable receipt in place, × dismisses. It never enters Needs Me. ' +
      'GOTCHA: one row per message. Before offering a kind again, read cat_cafe_suggestion_facts and weigh how the person treated it; there is no fixed limit.',
    inputSchema: offerSuggestionInputSchema,
    handler: handleOfferSuggestion,
    governance: {
      implementationExport: 'handleOfferSuggestion',
      action: 'create',
      risk: { level: 'write', openWorld: false },
      runtimeProfiles: ['full'],
      standaloneReason: admission,
    },
  }),
  defineTool({
    name: 'cat_cafe_post_action_receipt',
    description:
      'Leave one receipt line under a message for something you already did (「已向小星星补了一条先例」), optionally undoable. ' +
      'Use when: you acted without being asked in this turn and the person should see it where it happened. ' +
      'Not for: progress reports, asking for anything, or actions you have not done. ' +
      'Output: the row, right under that message. GOTCHA: one row per message; undo only for a scheduled task you registered in this conversation.',
    inputSchema: postActionReceiptInputSchema,
    handler: handlePostActionReceipt,
    governance: {
      implementationExport: 'handlePostActionReceipt',
      action: 'create',
      risk: { level: 'write', openWorld: false },
      runtimeProfiles: ['full'],
      standaloneReason: admission,
    },
  }),
  defineTool({
    name: 'cat_cafe_suggestion_facts',
    description:
      'Read how the person has treated each kind of one-tap suggestion: offered, used, changed afterwards, undone, dismissed, ignored, still open, and the latest few. ' +
      'Use when: deciding whether to offer a kind again, or deciding to stop offering one (stopOffering). ' +
      'Output: facts per kind; counts are facts, never a rule. GOTCHA: a stopped kind cannot be offered by you until the person restores it.',
    inputSchema: suggestionFactsInputSchema,
    handler: handleSuggestionFacts,
    governance: {
      implementationExport: 'handleSuggestionFacts',
      action: 'read',
      risk: { level: 'write', openWorld: false },
      runtimeProfiles: ['full'],
      standaloneReason: admission,
    },
  }),
] as const;
