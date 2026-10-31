/**
 * F268 durable receipt and aggregate sinks.
 *
 * Kept separate from HTTP route registration so persistence semantics and
 * transport validation remain independently reviewable.
 */

import { createHash } from 'node:crypto';
import type { CapabilityTipUsageEvent, TipEventBatch } from '@cat-cafe/shared';
import {
  TIP_AGGREGATE_TTL_SECONDS,
  TIP_RECEIPT_TTL_SECONDS,
  TIP_TRANSPORT_TTL_SECONDS,
  TipTelemetryKeys,
} from './tip-telemetry-keys.js';

export function computePayloadDigest(events: readonly CapabilityTipUsageEvent[], schemaVersion: number): string {
  const canonical = JSON.stringify({ events, schemaVersion });
  return createHash('sha256').update(canonical).digest('hex');
}

function utcDateBucket(epochMs: number): string {
  const date = new Date(epochMs);
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function utcHourBucket(epochMs: number): string {
  const date = new Date(epochMs);
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  const hour = String(date.getUTCHours()).padStart(2, '0');
  return `${year}-${month}-${day}T${hour}`;
}

interface AggregateIncrement {
  key: string;
  count: number;
}

function preAggregate(events: readonly CapabilityTipUsageEvent[]): AggregateIncrement[] {
  const counts = new Map<string, number>();

  for (const event of events) {
    const bucket = utcDateBucket(event.timestamp);
    const outcome = event.outcome ?? 'none';
    const key = TipTelemetryKeys.aggregate(bucket, event.tipId, event.event, outcome);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  return Array.from(counts.entries()).map(([key, count]) => ({ key, count }));
}

export type IngestStatus = 'accepted' | 'duplicate' | 'conflict' | 'unavailable';

export interface IngestResult {
  status: IngestStatus;
  eventCount: number;
}

export interface ITipEventSink {
  /** Atomically check/create a receipt and increment aggregate counters. */
  ingest(batch: TipEventBatch, sessionUserId: string): Promise<IngestResult>;
  /** Record a batch-unit transport health counter. */
  recordTransport(metric: string, count: number): void;
}

interface ReceiptRecord {
  digest: string;
  committedAt: number;
  eventCount: number;
}

export class InMemoryTipEventSink implements ITipEventSink {
  private receipts = new Map<string, ReceiptRecord>();
  private aggregates = new Map<string, number>();
  private transportCounters = new Map<string, number>();

  async ingest(batch: TipEventBatch, sessionUserId: string): Promise<IngestResult> {
    const receiptKey = `${sessionUserId}:${batch.batchId}`;
    const digest = computePayloadDigest(batch.events, batch.schemaVersion);
    const existing = this.receipts.get(receiptKey);

    if (existing) {
      return existing.digest === digest
        ? { status: 'duplicate', eventCount: existing.eventCount }
        : { status: 'conflict', eventCount: 0 };
    }

    this.receipts.set(receiptKey, {
      digest,
      committedAt: Date.now(),
      eventCount: batch.events.length,
    });

    for (const { key, count } of preAggregate(batch.events)) {
      this.aggregates.set(key, (this.aggregates.get(key) ?? 0) + count);
    }

    return { status: 'accepted', eventCount: batch.events.length };
  }

  recordTransport(metric: string, count: number): void {
    this.transportCounters.set(metric, (this.transportCounters.get(metric) ?? 0) + count);
  }

  getAggregate(dateBucket: string, tipId: string, event: string, outcome: string): number {
    const key = TipTelemetryKeys.aggregate(dateBucket, tipId, event, outcome);
    return this.aggregates.get(key) ?? 0;
  }

  getTransportCounter(metric: string): number {
    return this.transportCounters.get(metric) ?? 0;
  }

  getReceipt(sessionUserId: string, batchId: string): ReceiptRecord | undefined {
    return this.receipts.get(`${sessionUserId}:${batchId}`);
  }

  clear(): void {
    this.receipts.clear();
    this.aggregates.clear();
    this.transportCounters.clear();
  }
}

/** Narrow Redis interface used by the telemetry sink. */
export interface TipTelemetryRedisLike {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, exToken: 'EX', seconds: number): Promise<string | null>;
  incrby(key: string, increment: number): Promise<number>;
  expire(key: string, seconds: number): Promise<number>;
  eval(script: string, numkeys: number, ...args: (string | number)[]): Promise<unknown>;
}

/** Atomic receipt check plus aggregate increments. */
const INGEST_LUA = `
local existing = redis.call('GET', KEYS[1])
if existing then
  local data = cjson.decode(existing)
  if data.digest == ARGV[1] then
    return 1
  else
    return -1
  end
end

redis.call('SET', KEYS[1], ARGV[2], 'EX', tonumber(ARGV[3]))

local aggTtl = tonumber(ARGV[4])
local aggKeyCount = #KEYS - 1
for i = 1, aggKeyCount do
  local aggKey = KEYS[i + 1]
  local increment = tonumber(ARGV[i + 4])
  redis.call('INCRBY', aggKey, increment)
  redis.call('EXPIRE', aggKey, aggTtl)
end

return 0
`;

export class RedisTipEventSink implements ITipEventSink {
  constructor(private readonly redis: TipTelemetryRedisLike) {}

  async ingest(batch: TipEventBatch, sessionUserId: string): Promise<IngestResult> {
    const digest = computePayloadDigest(batch.events, batch.schemaVersion);
    const receiptKey = TipTelemetryKeys.receipt(sessionUserId, batch.batchId);
    const receiptValue = JSON.stringify({
      digest,
      committedAt: Date.now(),
      eventCount: batch.events.length,
    });
    const increments = preAggregate(batch.events);
    const keys = [receiptKey, ...increments.map((increment) => increment.key)];
    const args: (string | number)[] = [
      digest,
      receiptValue,
      TIP_RECEIPT_TTL_SECONDS,
      TIP_AGGREGATE_TTL_SECONDS,
      ...increments.map((increment) => increment.count),
    ];

    const result = (await this.redis.eval(INGEST_LUA, keys.length, ...keys, ...args)) as number;
    if (result === 1) return { status: 'duplicate', eventCount: batch.events.length };
    if (result === -1) return { status: 'conflict', eventCount: 0 };
    return { status: 'accepted', eventCount: batch.events.length };
  }

  recordTransport(metric: string, count: number): void {
    const hourBucket = utcHourBucket(Date.now());
    const key = TipTelemetryKeys.transport(hourBucket, metric);
    const script = `
      local newVal = redis.call('INCRBY', KEYS[1], tonumber(ARGV[1]))
      redis.call('EXPIRE', KEYS[1], tonumber(ARGV[2]))
      return newVal
    `;
    this.redis.eval(script, 1, key, count, TIP_TRANSPORT_TTL_SECONDS).catch(() => {});
  }
}

/** Fail-closed sink used when no durable Redis backend is available. */
export class UnavailableTipEventSink implements ITipEventSink {
  async ingest(): Promise<IngestResult> {
    return { status: 'unavailable', eventCount: 0 };
  }

  recordTransport(): void {
    // No durable backend exists for this diagnostic either.
  }
}
