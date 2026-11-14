import type { TurnExecutionRecord, TurnResponseSettlement } from '@cat-cafe/shared';

export type { TurnResponseSettlement } from '@cat-cafe/shared';

export interface SettledTurnQuery {
  watcherDays?: number[];
  watcherDay?: number;
  userId: string;
  threadId?: string;
  afterSequence?: number;
  limit?: number;
}

export interface SettledTurnPage {
  records: TurnExecutionRecord[];
  nextCursor: number;
  hasMore: boolean;
}

export interface SettleTurnResponseResult {
  outcome: 'settled' | 'replayed' | 'conflict' | 'not_ready' | 'not_found';
  record: TurnExecutionRecord | null;
}

export function assertResponseSettlement(value: unknown): asserts value is TurnResponseSettlement {
  if (!value || typeof value !== 'object') throw new Error('invalid turn response settlement');
  const input = value as Record<string, unknown>;
  if (typeof input.settledAt !== 'number' || !Number.isFinite(input.settledAt) || input.settledAt < 0)
    throw new Error('invalid response settlement timestamp');
  if (input.kind === 'message') {
    if (typeof input.messageId !== 'string' || !input.messageId.trim()) throw new Error('missing settled message');
  } else if (
    input.kind !== 'no_response' ||
    !['tool_only', 'empty_turn', 'recovered_no_response'].includes(String(input.reason))
  ) {
    throw new Error('invalid no-response settlement');
  }
}

export function responseSettlementIdentity(settlement: TurnResponseSettlement): string {
  return settlement.kind === 'message' ? `message:${settlement.messageId}` : `no_response:${settlement.reason}`;
}

export function responseSettlementReady(record: TurnExecutionRecord, settledAt: number): boolean {
  return (
    record.status !== 'running' &&
    record.endedAt !== undefined &&
    settledAt >= record.endedAt &&
    (record.status !== 'succeeded' ||
      record.providerTeardownAt === undefined ||
      settledAt >= record.providerTeardownAt) &&
    (record.status !== 'succeeded' ||
      !record.providerLifecycleTracked ||
      record.providerStartedAt === undefined ||
      record.providerTeardownAt !== undefined)
  );
}

export function settledTurnPageLimit(query: SettledTurnQuery): number {
  if (
    query.watcherDays &&
    (query.watcherDays.length < 1 ||
      query.watcherDays.length > 3 ||
      query.watcherDays.some((day) => !Number.isSafeInteger(day) || day < 0))
  )
    throw new Error('invalid watcher usage days');
  if (query.watcherDay !== undefined && (!Number.isSafeInteger(query.watcherDay) || query.watcherDay < 0))
    throw new Error('invalid watcher usage day');
  if (
    !query.userId ||
    (query.afterSequence !== undefined && (!Number.isSafeInteger(query.afterSequence) || query.afterSequence < 0))
  )
    throw new Error('invalid settled turn scope/cursor');
  const limit = query.limit ?? 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new Error('invalid settled turn page size');
  return limit;
}
