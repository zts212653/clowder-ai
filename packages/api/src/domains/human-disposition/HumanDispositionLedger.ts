import {
  buildHumanDispositionLedgerReceipt,
  type HumanDispositionLedgerEntry,
  type HumanDispositionLedgerReceipt,
  humanDispositionLedgerEntrySchema,
  humanDispositionLedgerReceiptSchema,
} from '@cat-cafe/shared';
import type { RedisClient } from '@cat-cafe/shared/utils';
import { z } from 'zod';
import { HumanDispositionKeys } from './human-disposition-keys.js';

const cursorSchema = z
  .object({
    decidedAt: z.number().finite().nonnegative(),
    sourceRef: z.string().trim().min(1).max(500),
  })
  .strict();

const pageOptionsSchema = z
  .object({
    limit: z.number().int().min(1).max(100),
    scanLimit: z.number().int().min(1).max(500).optional(),
    cursor: cursorSchema.optional(),
  })
  .strict();

export type HumanDispositionLedgerCursor = z.infer<typeof cursorSchema>;

export interface HumanDispositionLedgerPageOptions {
  limit: number;
  scanLimit?: number;
  cursor?: HumanDispositionLedgerCursor;
}

export interface HumanDispositionLedgerPage {
  entries: HumanDispositionLedgerEntry[];
  scannedCount: number;
  nextCursor?: HumanDispositionLedgerCursor;
}

export interface HumanDispositionLedgerQueryOptions extends HumanDispositionLedgerPageOptions {
  interactionKind?: string;
  subjectRef?: string;
}

export class HumanDispositionLedgerCursorError extends Error {
  constructor() {
    super('human disposition ledger cursor does not match immutable index truth');
    this.name = 'HumanDispositionLedgerCursorError';
  }
}

export class HumanDispositionLedgerInvariantError extends Error {
  constructor() {
    super('human disposition ledger receipt cannot hydrate exact producer truth');
    this.name = 'HumanDispositionLedgerInvariantError';
  }
}

export interface HumanDispositionProducerEntryLoader {
  loadEntry(input: {
    ownerUserId: string;
    receipt: HumanDispositionLedgerReceipt;
  }): Promise<HumanDispositionLedgerEntry | null>;
}

interface LedgerListBehavior {
  strictHydration?: boolean;
  interactionKind?: string;
}

function indexedCursor(raw: string[], index: number): HumanDispositionLedgerCursor | null {
  const sourceRef = raw[index * 2];
  const scoreText = raw[index * 2 + 1];
  if (sourceRef === undefined || scoreText === undefined) return null;
  return { decidedAt: Number(scoreText), sourceRef };
}

function shouldIncludeEntry(
  entry: HumanDispositionLedgerEntry | null,
  behavior: LedgerListBehavior,
): entry is HumanDispositionLedgerEntry {
  if (!entry && behavior.strictHydration) throw new HumanDispositionLedgerInvariantError();
  return entry !== null && (!behavior.interactionKind || entry.episode.interactionKind === behavior.interactionKind);
}

export class HumanDispositionLedger {
  constructor(
    private readonly redis: RedisClient,
    private readonly producerLoader: HumanDispositionProducerEntryLoader,
  ) {}

  async get(ownerUserId: string, sourceRef: string): Promise<HumanDispositionLedgerEntry | null> {
    const raw = await this.redis.hget(HumanDispositionKeys.receipts(ownerUserId), sourceRef);
    if (!raw) return null;
    const receipt = humanDispositionLedgerReceiptSchema.safeParse(this.parseJson(raw));
    if (!receipt.success || receipt.data.sourceRef !== sourceRef) return null;
    if (!(await this.hasExactIndexes(ownerUserId, receipt.data))) return null;
    return this.hydrate(ownerUserId, receipt.data);
  }

  async listByOwner(
    ownerUserId: string,
    options: HumanDispositionLedgerPageOptions,
  ): Promise<HumanDispositionLedgerPage> {
    return this.listIndex(ownerUserId, HumanDispositionKeys.episodes(ownerUserId), options);
  }

  async listBySubject(
    ownerUserId: string,
    subjectRef: string,
    options: HumanDispositionLedgerPageOptions,
  ): Promise<HumanDispositionLedgerPage> {
    return this.listIndex(ownerUserId, HumanDispositionKeys.subject(ownerUserId, subjectRef), options, subjectRef);
  }

  async query(ownerUserId: string, options: HumanDispositionLedgerQueryOptions): Promise<HumanDispositionLedgerPage> {
    const { interactionKind, subjectRef, ...pageOptions } = options;
    const indexKey = subjectRef
      ? HumanDispositionKeys.subject(ownerUserId, subjectRef)
      : HumanDispositionKeys.episodes(ownerUserId);
    return this.listIndex(ownerUserId, indexKey, pageOptions, subjectRef, {
      strictHydration: true,
      interactionKind,
    });
  }

  private async listIndex(
    ownerUserId: string,
    indexKey: string,
    optionsInput: HumanDispositionLedgerPageOptions,
    expectedSubjectRef?: string,
    behavior: LedgerListBehavior = {},
  ): Promise<HumanDispositionLedgerPage> {
    const options = pageOptionsSchema.parse(optionsInput);
    const scanLimit = options.scanLimit ?? Math.min(Math.max(options.limit * 4, 20), 500);
    const startRank = await this.resolveStartRank(
      ownerUserId,
      indexKey,
      options.cursor,
      expectedSubjectRef,
      behavior.strictHydration === true,
    );
    if (startRank === null) return { entries: [], scannedCount: 0 };

    const raw = await this.redis.zrevrange(indexKey, startRank, startRank + scanLimit, 'WITHSCORES');
    const availablePairs = Math.floor(raw.length / 2);
    const processCount = Math.min(availablePairs, scanLimit);
    const entries: HumanDispositionLedgerEntry[] = [];
    let scannedCount = 0;
    let lastScanned: HumanDispositionLedgerCursor | undefined;
    let hasMore = availablePairs > processCount;

    for (let index = 0; index < processCount; index += 1) {
      const cursor = indexedCursor(raw, index);
      if (!cursor) break;
      scannedCount += 1;
      lastScanned = cursor;

      const entry = await this.hydrateIndexedReceipt(ownerUserId, lastScanned, expectedSubjectRef);
      if (shouldIncludeEntry(entry, behavior)) entries.push(entry);

      if (entries.length === options.limit) {
        hasMore = hasMore || index + 1 < availablePairs;
        break;
      }
    }

    return {
      entries,
      scannedCount,
      ...(hasMore && lastScanned ? { nextCursor: lastScanned } : {}),
    };
  }

  private async resolveStartRank(
    ownerUserId: string,
    indexKey: string,
    cursor: HumanDispositionLedgerCursor | undefined,
    expectedSubjectRef: string | undefined,
    strict: boolean,
  ): Promise<number | null> {
    if (!cursor) return 0;
    const [rank, score] = await Promise.all([
      this.redis.zrevrank(indexKey, cursor.sourceRef),
      this.redis.zscore(indexKey, cursor.sourceRef),
    ]);
    if (rank === null || score === null || Number(score) !== cursor.decidedAt) {
      if (strict) throw new HumanDispositionLedgerCursorError();
      return null;
    }
    if (strict) {
      const entry = await this.hydrateIndexedReceipt(ownerUserId, cursor, expectedSubjectRef);
      if (!entry) throw new HumanDispositionLedgerInvariantError();
    }
    return rank + 1;
  }

  private async hydrateIndexedReceipt(
    ownerUserId: string,
    cursor: HumanDispositionLedgerCursor,
    expectedSubjectRef?: string,
  ): Promise<HumanDispositionLedgerEntry | null> {
    const receiptRaw = await this.redis.hget(HumanDispositionKeys.receipts(ownerUserId), cursor.sourceRef);
    const receipt = humanDispositionLedgerReceiptSchema.safeParse(this.parseJson(receiptRaw));
    if (
      !receipt.success ||
      receipt.data.sourceRef !== cursor.sourceRef ||
      receipt.data.decidedAt !== cursor.decidedAt
    ) {
      return null;
    }
    if (expectedSubjectRef !== undefined && receipt.data.subjectRef !== expectedSubjectRef) return null;
    if (!(await this.hasExactIndexes(ownerUserId, receipt.data))) return null;
    return this.hydrate(ownerUserId, receipt.data);
  }

  private async hasExactIndexes(ownerUserId: string, receipt: HumanDispositionLedgerReceipt): Promise<boolean> {
    const [ownerScore, subjectScore] = await Promise.all([
      this.redis.zscore(HumanDispositionKeys.episodes(ownerUserId), receipt.sourceRef),
      this.redis.zscore(HumanDispositionKeys.subject(ownerUserId, receipt.subjectRef), receipt.sourceRef),
    ]);
    return (
      ownerScore !== null &&
      subjectScore !== null &&
      Number(ownerScore) === receipt.decidedAt &&
      Number(subjectScore) === receipt.decidedAt
    );
  }

  private async hydrate(
    ownerUserId: string,
    receipt: HumanDispositionLedgerReceipt,
  ): Promise<HumanDispositionLedgerEntry | null> {
    try {
      const loaded = await this.producerLoader.loadEntry({ ownerUserId, receipt });
      const entry = humanDispositionLedgerEntrySchema.safeParse(loaded);
      if (!entry.success || entry.data.episode.ownerUserId !== ownerUserId) return null;
      const canonicalReceipt = buildHumanDispositionLedgerReceipt(entry.data);
      return JSON.stringify(canonicalReceipt) === JSON.stringify(receipt) ? entry.data : null;
    } catch {
      return null;
    }
  }

  private parseJson(raw: string | null): unknown {
    if (raw === null) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }
}
