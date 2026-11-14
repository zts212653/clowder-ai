import { z } from 'zod';

export const REMEMBER_TARGETS = [
  'profile',
  'taste',
  'person',
  'person_defer',
  'person_abstain',
  'person_revision',
  'entity',
  'event_correction',
  'matter',
] as const;
export const rememberItemSchema = z
  .object({
    itemId: z.string().min(1).max(64),
    target: z.enum(REMEMBER_TARGETS),
    /** The existing submission's body. The original route validates its domain schema. */
    payload: z.record(z.string(), z.unknown()),
  })
  .strict();
export const rememberInputSchema = z
  .object({
    clientRequestId: z.string().min(1).max(160),
    items: z.array(rememberItemSchema).min(1).max(4),
  })
  .strict()
  .refine((input) => new Set(input.items.map((item) => item.itemId)).size === input.items.length, {
    message: 'Each itemId must be distinct within this request',
    path: ['items'],
  });
export type RememberItem = z.infer<typeof rememberItemSchema>;
export type RememberInput = z.infer<typeof rememberInputSchema>;
/** Presentation references only. The original proposal/receipt owns the decision and stored content. */
export interface RememberGroupRow {
  itemId: string;
  target: RememberItem['target'];
  statusCode: number;
  proposalId?: string;
  messageId?: string;
  resultRef?: string;
  status?: string;
  error?: string;
}
export interface RememberGroup {
  v: 1;
  groupId: string;
  rows: RememberGroupRow[];
}
export interface RememberRowResult {
  itemId: string;
  target: RememberItem['target'];
  statusCode: number;
  result: unknown;
}
export interface RememberResult {
  groupId: string;
  messageId: string;
  results: RememberRowResult[];
}
