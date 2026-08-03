import { TipTelemetryKeys } from '../../../routes/tip-telemetry-keys.js';

const DAY_MS = 24 * 60 * 60 * 1_000;
const MAX_WINDOW_MS = 90 * DAY_MS;
const USAGE_EVENTS = ['capability_tip_exposed', 'capability_tip_action', 'capability_tip_dismissed'] as const;
const OUTCOMES = ['shown', 'opened', 'dismissed', 'failed', 'none'] as const;
const TRANSPORT_STATUSES = ['accepted', 'duplicate', 'rejected', 'conflict'] as const;

type UsageEvent = (typeof USAGE_EVENTS)[number];
type UsageOutcome = (typeof OUTCOMES)[number];
type TransportStatus = (typeof TRANSPORT_STATUSES)[number];

export interface CapabilityTipsUsageSelector {
  kind: 'capability-tips-usage-window';
  windowStartMs: number;
  windowEndMs: number;
}

export interface CapabilityTipsUsageRow {
  date: string;
  tipId: string;
  event: UsageEvent;
  outcome: UsageOutcome;
  count: number;
}

export interface CapabilityTipsUsageSnapshot {
  kind: 'capability-tips-usage-window';
  schemaVersion: 1;
  status: 'no_data' | 'insufficient';
  window: { startMs: number; endMs: number };
  summary: { opportunity: null; exposure: number; action: number; dismiss: number; failure: number };
  transport: Record<TransportStatus, number>;
  opportunity: { status: 'unavailable'; count: null; reason: 'no_canonical_opportunity_source' };
  rows: CapabilityTipsUsageRow[];
  diagnostics: {
    scannedAggregateKeys: number;
    malformedAggregateKeys: number;
    malformedAggregateValues: number;
    scannedTransportKeys: number;
    malformedTransportKeys: number;
    malformedTransportValues: number;
  };
  provenance: {
    sourceAdapter: 'capability-tips-usage';
    aggregateSchemaVersion: 1;
    aggregateRetentionDays: 90;
    transportRetentionDays: 14;
    windowBoundary: 'utc-day-aligned-half-open';
    identityScope: 'deployment-aggregate';
  };
  limitations: readonly [
    'opportunity_denominator_unavailable',
    'dismiss_producer_absent',
    'click_is_not_effectiveness',
  ];
}

type UsageDiagnostics = CapabilityTipsUsageSnapshot['diagnostics'];

export interface CapabilityTipsUsageRedis {
  options?: { keyPrefix?: string };
  scan(cursor: string, ...args: (string | number)[]): Promise<[string, string[]]>;
  mget(...keys: string[]): Promise<(string | null)[]>;
}

interface StoredEntry {
  key: string;
  value: string | null;
}

export function validateCapabilityTipsUsageSelector(selector: unknown): string | null {
  if (!selector || typeof selector !== 'object') return 'selector must be an object';
  const value = selector as Record<string, unknown>;
  if (value.kind !== 'capability-tips-usage-window') return "kind must be 'capability-tips-usage-window'";
  if (!isEpochMs(value.windowStartMs) || !isEpochMs(value.windowEndMs)) {
    return 'windowStartMs and windowEndMs must be non-negative safe-integer epoch milliseconds';
  }
  if (value.windowEndMs <= value.windowStartMs) return 'windowEndMs must be greater than windowStartMs';
  if (!isUtcMidnight(value.windowStartMs) || !isUtcMidnight(value.windowEndMs)) {
    return 'windowStartMs and windowEndMs must align to UTC midnight';
  }
  if (value.windowEndMs - value.windowStartMs > MAX_WINDOW_MS) return 'window must not exceed 90 days';
  return null;
}

export class CapabilityTipsUsageAdapter {
  constructor(private readonly redis: CapabilityTipsUsageRedis) {}

  async resolve(selector: CapabilityTipsUsageSelector): Promise<CapabilityTipsUsageSnapshot> {
    const error = validateCapabilityTipsUsageSelector(selector);
    if (error) throw new Error(`invalid capability tips selector: ${error}`);

    const [aggregateEntries, transportEntries] = await Promise.all([
      this.scan(TipTelemetryKeys.allAggregates),
      this.scan(TipTelemetryKeys.allTransport),
    ]);
    const diagnostics = {
      scannedAggregateKeys: aggregateEntries.length,
      malformedAggregateKeys: 0,
      malformedAggregateValues: 0,
      scannedTransportKeys: transportEntries.length,
      malformedTransportKeys: 0,
      malformedTransportValues: 0,
    };
    const rows = collectUsageRows(aggregateEntries, selector, diagnostics);
    rows.sort(compareRows);
    const transport = collectTransport(transportEntries, selector, diagnostics);

    const summary = summarize(rows);
    const malformedCount =
      diagnostics.malformedAggregateKeys +
      diagnostics.malformedAggregateValues +
      diagnostics.malformedTransportKeys +
      diagnostics.malformedTransportValues;
    const observedCount = rows.reduce((total, row) => total + row.count, 0) + sumTransport(transport);

    return {
      kind: 'capability-tips-usage-window',
      schemaVersion: 1,
      status: observedCount === 0 && malformedCount === 0 ? 'no_data' : 'insufficient',
      window: { startMs: selector.windowStartMs, endMs: selector.windowEndMs },
      summary,
      transport,
      opportunity: { status: 'unavailable', count: null, reason: 'no_canonical_opportunity_source' },
      rows,
      diagnostics,
      provenance: {
        sourceAdapter: 'capability-tips-usage',
        aggregateSchemaVersion: 1,
        aggregateRetentionDays: 90,
        transportRetentionDays: 14,
        windowBoundary: 'utc-day-aligned-half-open',
        identityScope: 'deployment-aggregate',
      },
      limitations: ['opportunity_denominator_unavailable', 'dismiss_producer_absent', 'click_is_not_effectiveness'],
    };
  }

  private async scan(pattern: string): Promise<StoredEntry[]> {
    const keyPrefix = this.redis.options?.keyPrefix ?? '';
    const entries: StoredEntry[] = [];
    const seenKeys = new Set<string>();
    let cursor = '0';
    do {
      const [nextCursor, rawKeys] = await this.redis.scan(cursor, 'MATCH', `${keyPrefix}${pattern}`, 'COUNT', 500);
      cursor = nextCursor;
      const keys = rawKeys
        .map((key) => (keyPrefix && key.startsWith(keyPrefix) ? key.slice(keyPrefix.length) : key))
        .filter((key) => {
          if (seenKeys.has(key)) return false;
          seenKeys.add(key);
          return true;
        });
      const values = keys.length > 0 ? await this.redis.mget(...keys) : [];
      for (let index = 0; index < keys.length; index++) {
        const key = keys[index];
        if (key !== undefined) entries.push({ key, value: values[index] ?? null });
      }
    } while (cursor !== '0');
    return entries;
  }
}

const aggregateKeyPattern = new RegExp(
  `^tip-telemetry:agg:(\\d{4}-\\d{2}-\\d{2}):([a-z0-9][a-z0-9-]{0,63}):(${USAGE_EVENTS.join('|')}):(${OUTCOMES.join('|')})$`,
);
const transportKeyPattern = new RegExp(
  `^tip-telemetry:transport:(\\d{4}-\\d{2}-\\d{2}T\\d{2}):(${TRANSPORT_STATUSES.join('|')})$`,
);

function parseAggregateKey(key: string): Omit<CapabilityTipsUsageRow, 'count'> | null {
  const match = aggregateKeyPattern.exec(key);
  if (!match) return null;
  const [, date, tipId, event, outcome] = match;
  if (!date || !tipId || !event || !outcome || !isValidUtcDate(date)) return null;
  return { date, tipId, event: event as UsageEvent, outcome: outcome as UsageOutcome };
}

function parseTransportKey(key: string): { epochMs: number; status: TransportStatus } | null {
  const match = transportKeyPattern.exec(key);
  if (!match) return null;
  const epochMs = Date.parse(`${match[1]}:00:00.000Z`);
  if (!Number.isFinite(epochMs) || new Date(epochMs).toISOString().slice(0, 13) !== match[1]) return null;
  return { epochMs, status: match[2] as TransportStatus };
}

function parseCount(value: string | null): number | null {
  if (value === null || !/^[1-9]\d*$/.test(value)) return null;
  const count = Number(value);
  return Number.isSafeInteger(count) ? count : null;
}

function collectUsageRows(
  entries: StoredEntry[],
  selector: CapabilityTipsUsageSelector,
  diagnostics: UsageDiagnostics,
): CapabilityTipsUsageRow[] {
  const rows: CapabilityTipsUsageRow[] = [];
  for (const entry of entries) {
    const parsed = parseAggregateKey(entry.key);
    if (!parsed) {
      diagnostics.malformedAggregateKeys++;
      continue;
    }
    if (!dateInWindow(parsed.date, selector)) continue;
    const count = parseCount(entry.value);
    if (count === null) {
      diagnostics.malformedAggregateValues++;
      continue;
    }
    rows.push({ ...parsed, count });
  }
  return rows;
}

function collectTransport(
  entries: StoredEntry[],
  selector: CapabilityTipsUsageSelector,
  diagnostics: UsageDiagnostics,
): Record<TransportStatus, number> {
  const transport = emptyTransport();
  for (const entry of entries) {
    const parsed = parseTransportKey(entry.key);
    if (!parsed) {
      diagnostics.malformedTransportKeys++;
      continue;
    }
    if (parsed.epochMs < selector.windowStartMs || parsed.epochMs >= selector.windowEndMs) continue;
    const count = parseCount(entry.value);
    if (count === null) {
      diagnostics.malformedTransportValues++;
      continue;
    }
    transport[parsed.status] += count;
  }
  return transport;
}

function summarize(rows: CapabilityTipsUsageRow[]): CapabilityTipsUsageSnapshot['summary'] {
  const summary = { opportunity: null, exposure: 0, action: 0, dismiss: 0, failure: 0 };
  for (const row of rows) {
    if (row.event === 'capability_tip_exposed') summary.exposure += row.count;
    if (row.event === 'capability_tip_action') summary.action += row.count;
    if (row.event === 'capability_tip_dismissed') summary.dismiss += row.count;
    if (row.outcome === 'failed') summary.failure += row.count;
  }
  return summary;
}

function emptyTransport(): Record<TransportStatus, number> {
  return { accepted: 0, duplicate: 0, rejected: 0, conflict: 0 };
}

function sumTransport(transport: Record<TransportStatus, number>): number {
  return TRANSPORT_STATUSES.reduce((total, status) => total + transport[status], 0);
}

function dateInWindow(date: string, selector: CapabilityTipsUsageSelector): boolean {
  const epochMs = Date.parse(`${date}T00:00:00.000Z`);
  return epochMs >= selector.windowStartMs && epochMs < selector.windowEndMs;
}

function compareRows(left: CapabilityTipsUsageRow, right: CapabilityTipsUsageRow): number {
  return `${left.date}:${left.tipId}:${left.event}:${left.outcome}`.localeCompare(
    `${right.date}:${right.tipId}:${right.event}:${right.outcome}`,
  );
}

function isEpochMs(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isUtcMidnight(epochMs: number): boolean {
  const date = new Date(epochMs);
  return (
    date.getUTCHours() === 0 &&
    date.getUTCMinutes() === 0 &&
    date.getUTCSeconds() === 0 &&
    date.getUTCMilliseconds() === 0
  );
}

function isValidUtcDate(date: string): boolean {
  const epochMs = Date.parse(`${date}T00:00:00.000Z`);
  return Number.isFinite(epochMs) && new Date(epochMs).toISOString().slice(0, 10) === date;
}
