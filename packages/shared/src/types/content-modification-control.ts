import { z } from 'zod';

const id = z.string().min(1).max(256);
export const contentRuntimeControlTargetSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('stop_execution'), executionId: id, invocationId: id }).strict(),
  z.object({ kind: z.literal('withdraw_single'), entryId: id, messageId: id }).strict(),
  z.object({ kind: z.literal('withdraw_queue'), entryId: id, messageId: id }).strict(),
]);
export type ContentRuntimeControlTarget = z.infer<typeof contentRuntimeControlTargetSchema>;
/** A human decision about one frozen object. Native owner acknowledgements are historical receipts. */
export interface ContentRuntimeControl {
  receiptRef: string;
  requestId: string;
  ownerUserId: string;
  threadId: string;
  catId: string;
  target: ContentRuntimeControlTarget;
  confirmedAt: number;
  state: 'confirmed' | 'acknowledged';
  observation?: { statusCode: number; code?: string; observedAt: number };
  /** Fresh canonical child read for this frozen target; not persisted by the control journal. */
  executionState?: 'running' | 'succeeded' | 'failed' | 'canceled' | 'interrupted' | 'unknown';
}
