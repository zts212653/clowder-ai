import {
  assertQueueLedgerEntry,
  type QueueLedgerEntry,
  type QueueLedgerTransitionResult,
  queueEntryId,
} from './QueueLedger.js';

type PersistedQueueRow = Record<string, unknown> & {
  version?: unknown;
  status?: unknown;
  target?: unknown;
  targets?: unknown;
  payload?: unknown;
  delivery?: unknown;
  enqueuedAt?: unknown;
};

export interface QueueLedgerV2MigrationPlan {
  entries: Array<[id: string, raw: string]>;
  order: string[];
  messageIndex: Record<string, string[]>;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Collapse retired v1 source×target rows into one pending v2 source entry. */
export function migrateQueueLedgerRowsToV2(
  rawById: Readonly<Record<string, string>>,
  persistedOrder: readonly string[],
): QueueLedgerV2MigrationPlan {
  const orderRank = new Map(persistedOrder.map((id, index) => [id, index]));
  const candidates = Object.entries(rawById)
    .map(([storedId, raw]) => {
      const parsed = JSON.parse(raw) as unknown;
      const row = record(parsed) as PersistedQueueRow | null;
      if (!row) throw new Error(`corrupt queue ledger row: ${storedId}`);
      return { storedId, row };
    })
    .sort((left, right) => {
      const leftRank = orderRank.get(left.storedId) ?? Number.MAX_SAFE_INTEGER;
      const rightRank = orderRank.get(right.storedId) ?? Number.MAX_SAFE_INTEGER;
      if (leftRank !== rightRank) return leftRank - rightRank;
      const leftAt = typeof left.row.enqueuedAt === 'number' ? left.row.enqueuedAt : Number.MAX_SAFE_INTEGER;
      const rightAt = typeof right.row.enqueuedAt === 'number' ? right.row.enqueuedAt : Number.MAX_SAFE_INTEGER;
      return leftAt - rightAt || left.storedId.localeCompare(right.storedId);
    });

  const grouped = new Map<
    string,
    { row: Record<string, unknown>; targets: string[]; seenTargets: Set<string>; intents: Record<string, unknown> }
  >();
  for (const { storedId, row } of candidates) {
    if (row.version !== 1 && row.version !== 2) {
      throw new Error(`unsupported queue ledger entry version: ${String(row.version)}`);
    }
    if (row.status !== 'queued' && row.status !== 'claimed') continue;
    const payload = record(row.payload);
    const sourceRecordId = payload?.sourceRecordId ?? payload?.sourceId;
    if (typeof sourceRecordId !== 'string' || !sourceRecordId) {
      throw new Error(`queue ledger payload identity is incomplete: ${storedId}`);
    }
    const rawTargets: string[] = [];
    if (Array.isArray(row.targets)) {
      for (const targetId of row.targets) {
        if (typeof targetId !== 'string' || !targetId) throw new Error(`queue ledger targets are invalid: ${storedId}`);
        rawTargets.push(targetId);
      }
    } else {
      const target = record(row.target);
      if (target?.kind === 'cat' && typeof target.catId === 'string' && target.catId) rawTargets.push(target.catId);
      else if (target?.kind !== 'unassigned') throw new Error(`queue ledger target is invalid: ${storedId}`);
    }

    let group = grouped.get(sourceRecordId);
    if (!group) {
      const nextPayload: Record<string, unknown> = { ...payload, sourceRecordId };
      delete nextPayload.sourceId;
      const nextRow: Record<string, unknown> = {
        ...row,
        version: 2,
        id: queueEntryId(sourceRecordId),
        payload: nextPayload,
      };
      delete nextRow.target;
      delete nextRow.claimId;
      delete nextRow.claimedAt;
      delete nextRow.claimedTargetIds;
      delete nextRow.claimedFromTargetless;
      delete nextRow.processingStartedAt;
      delete nextRow.terminalAt;
      delete nextRow.retiringGroupId;
      nextRow.status = 'queued';
      group = { row: nextRow, targets: [], seenTargets: new Set(), intents: {} };
      grouped.set(sourceRecordId, group);
    }
    for (const targetId of rawTargets) {
      if (!group.seenTargets.has(targetId)) {
        group.seenTargets.add(targetId);
        group.targets.push(targetId);
      }
    }
    const delivery = record(row.delivery);
    const byTarget = record(delivery?.authorIntentByTarget);
    if (byTarget) {
      for (const targetId of rawTargets) {
        if (byTarget[targetId] !== undefined) group.intents[targetId] = byTarget[targetId];
      }
    } else if (delivery?.authorIntent !== undefined && rawTargets.length === 1) {
      group.intents[rawTargets[0] as string] = delivery.authorIntent;
    }
  }

  const entries: Array<[string, string]> = [];
  const order: string[] = [];
  const messageIndex: Record<string, string[]> = {};
  for (const group of grouped.values()) {
    const pendingIntents = Object.fromEntries(
      group.targets.flatMap((targetId) =>
        group.intents[targetId] === undefined ? [] : [[targetId, group.intents[targetId]]],
      ),
    );
    group.row.targets = group.targets;
    group.row.delivery = Object.keys(pendingIntents).length > 0 ? { authorIntentByTarget: pendingIntents } : {};
    const entry = group.row as unknown as QueueLedgerEntry;
    assertQueueLedgerEntry(entry);
    const raw = JSON.stringify(entry);
    entries.push([entry.id, raw]);
    order.push(entry.id);
    if (entry.payload.messageId) messageIndex[entry.payload.messageId] = [entry.id];
  }
  return { entries, order, messageIndex };
}

export function hydrateQueueLedgerEntry(raw: string): QueueLedgerEntry {
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object') throw new Error('corrupt queue ledger row');
  const entry = parsed as QueueLedgerEntry;
  assertQueueLedgerEntry(entry);
  return entry;
}

export function hydrateQueueMessageIndex(raw: string, messageId: string): string[] {
  const parsed: unknown = JSON.parse(raw);
  if (
    !Array.isArray(parsed) ||
    parsed.length === 0 ||
    parsed.some((entryId) => typeof entryId !== 'string' || entryId.length === 0) ||
    new Set(parsed).size !== parsed.length
  ) {
    throw new Error(`corrupt queue message index: ${messageId}`);
  }
  return parsed;
}

export function queueLedgerTransitionResult(raw: unknown): QueueLedgerTransitionResult {
  if (!Array.isArray(raw)) throw new Error('invalid queue ledger transition reply');
  const outcome = Number(raw[0]);
  if (outcome === -1) return { outcome: 'not_found' };
  if (outcome === 0) return { outcome: 'state_changed' };
  if (outcome !== 1 || typeof raw[1] !== 'string') throw new Error('invalid queue ledger transition outcome');
  return { outcome: 'updated', entry: hydrateQueueLedgerEntry(raw[1]) };
}
