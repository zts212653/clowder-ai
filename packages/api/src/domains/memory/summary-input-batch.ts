import { compareCursors, parseCursor } from '../cats/services/stores/cursor.js';
import type { AbstractiveMessage } from './abstractive-summary-types.js';
import { buildSearchableMessageContent } from './message-search-content.js';

export interface SummaryCounterAmounts {
  count: number;
  tokens: number;
}
export interface SummaryScannedMessage {
  id: string;
  tokenCount: number;
  cursor?: string;
}
/** Only model material has bodies; filtered rows contribute content-free accounting. */
export interface SummaryReadBatch {
  messages: AbstractiveMessage[];
  scannedMessages: readonly SummaryScannedMessage[];
  /** A full bounded page has not proved exhaustion; keep a durable continuation hint. */
  scanIncomplete?: boolean;
}
export interface SummaryInputSettlement {
  expectedWatermark: string | null;
  lastMessageId: string;
  processed: SummaryCounterAmounts;
  pending: SummaryCounterAmounts;
}

export function normalizeSummaryReadBatch(input: AbstractiveMessage[] | SummaryReadBatch): SummaryReadBatch {
  return Array.isArray(input)
    ? {
        messages: input,
        scannedMessages: input.map((m) => ({
          id: m.id,
          tokenCount: Math.ceil(buildSearchableMessageContent(m).length / 4),
        })),
      }
    : input;
}

export function summaryBatchAmounts(rows: readonly SummaryScannedMessage[]): SummaryCounterAmounts {
  return { count: rows.length, tokens: rows.reduce((sum, row) => sum + row.tokenCount, 0) };
}

/** The extra count is a scheduling hint; unknown input has no fabricated token estimate. */
export function summaryPendingAmounts(
  rows: readonly SummaryScannedMessage[],
  scanIncomplete = false,
): SummaryCounterAmounts {
  const amounts = summaryBatchAmounts(rows);
  return { ...amounts, count: amounts.count + (scanIncomplete ? 1 : 0) };
}

/** Stop before the first unread model message; its preceding filtered rows may be acknowledged. */
export function planSummaryInputSettlement(
  batch: SummaryReadBatch,
  coveredCount: number,
  expectedWatermark: string | null,
): SummaryInputSettlement | null {
  const unread = batch.messages[coveredCount];
  const boundary = unread
    ? batch.scannedMessages.findIndex((row) => row.id === unread.id)
    : batch.scannedMessages.length;
  if (boundary <= 0) return null;
  const processed = batch.scannedMessages.slice(0, boundary);
  return {
    expectedWatermark,
    lastMessageId: processed.at(-1)!.cursor ?? processed.at(-1)!.id,
    processed: summaryBatchAmounts(processed),
    pending: summaryPendingAmounts(batch.scannedMessages.slice(boundary), batch.scanIncomplete),
  };
}

/** Historical catch-up must not subtract counters belonging to a newer live watermark. */
export function planHistoricalSummaryInputSettlement(
  batch: SummaryReadBatch,
  coveredCount: number,
  watermark: string | null,
  canonicalWatermark: string | null = watermark,
): SummaryInputSettlement | null {
  const settlement = planSummaryInputSettlement(batch, coveredCount, watermark);
  if (!settlement) return null;
  const endId = parseCursor(settlement.lastMessageId)!.id;
  const boundary = batch.scannedMessages.findIndex((row) => row.id === endId) + 1;
  const isAfter = (row: SummaryScannedMessage) => {
    if (!watermark) return true;
    if (!row.cursor || parseCursor(row.cursor)?.version !== 2 || parseCursor(canonicalWatermark)?.version !== 2)
      throw new Error('historical_summary_position_unresolved');
    return compareCursors(row.cursor, canonicalWatermark!) > 0;
  };
  if (!isAfter(batch.scannedMessages[boundary - 1])) return null;
  const afterWatermark = (rows: readonly SummaryScannedMessage[]) => rows.filter(isAfter);
  return {
    ...settlement,
    processed: summaryBatchAmounts(afterWatermark(batch.scannedMessages.slice(0, boundary))),
    pending: summaryPendingAmounts(afterWatermark(batch.scannedMessages.slice(boundary)), batch.scanIncomplete),
  };
}

/** Subtract only the acknowledged prefix from live counters, retaining concurrent appends. */
export function retainSummaryInputCounters(
  current: { pending_message_count: number; pending_token_count: number; pending_signal_flags: number },
  processed: SummaryCounterAmounts,
  pending: SummaryCounterAmounts,
) {
  const count = Math.max(pending.count, current.pending_message_count - processed.count);
  if (count === 0) return { count: 0, tokens: 0, flags: 0, carryOver: 0 };
  return {
    count,
    tokens: Math.max(pending.tokens, current.pending_token_count - processed.tokens),
    flags: current.pending_signal_flags,
    carryOver: 1,
  };
}
