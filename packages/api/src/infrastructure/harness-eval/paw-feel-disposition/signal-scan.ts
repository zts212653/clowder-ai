import type { RedisClient } from '@cat-cafe/shared/utils';

const SCAN_CALL_LIMIT = 8;
const PENDING_LIMIT = 50;
const SIGNAL_ID_MAX_LENGTH = 1_000;

export interface PawFeelSignalScanCursorV1 {
  redisCursor: string;
  pendingSignalIds: readonly string[];
  completeAfterPending: boolean;
}

export interface PawFeelSignalScanPage {
  signalIds: readonly string[];
  scanCalls: number;
  nextCursor?: PawFeelSignalScanCursorV1;
}

function validSignalId(signalId: string): boolean {
  return signalId.length > 0 && signalId.length <= SIGNAL_ID_MAX_LENGTH;
}

function parseCursor(cursor: PawFeelSignalScanCursorV1): PawFeelSignalScanCursorV1 {
  const pendingSignalIds = [...cursor.pendingSignalIds];
  const completeStateValid = cursor.completeAfterPending
    ? cursor.redisCursor === '0' && pendingSignalIds.length > 0
    : cursor.redisCursor !== '0';
  if (
    !/^\d{1,40}$/u.test(cursor.redisCursor) ||
    pendingSignalIds.length > PENDING_LIMIT ||
    pendingSignalIds.some((signalId) => !validSignalId(signalId)) ||
    new Set(pendingSignalIds).size !== pendingSignalIds.length ||
    !completeStateValid
  ) {
    throw new Error('invalid paw-feel signal scan cursor');
  }
  return { redisCursor: cursor.redisCursor, pendingSignalIds, completeAfterPending: cursor.completeAfterPending };
}

function requireLimit(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) {
    throw new RangeError('paw-feel signal scan limit must be between 1 and 50');
  }
}

class SignalScanAccumulator {
  readonly signalIds: string[] = [];
  readonly pendingSignalIds: string[];
  private readonly pageSet = new Set<string>();
  private readonly pendingSet: Set<string>;
  redisCursor: string;
  scanCalls = 0;

  constructor(
    cursor: PawFeelSignalScanCursorV1 | undefined,
    private readonly limit: number,
  ) {
    this.redisCursor = cursor?.redisCursor ?? '0';
    this.pendingSignalIds = cursor ? [...cursor.pendingSignalIds] : [];
    this.pendingSet = new Set(this.pendingSignalIds);
  }

  get full(): boolean {
    return this.signalIds.length === this.limit;
  }

  drainPending(): void {
    while (this.pendingSignalIds.length > 0 && !this.full) {
      const signalId = this.pendingSignalIds.shift();
      if (!signalId) continue;
      this.pendingSet.delete(signalId);
      this.addToPage(signalId);
    }
  }

  addScan(nextRedisCursor: string, matches: readonly string[]): void {
    if (!/^\d{1,40}$/u.test(nextRedisCursor) || matches.some((signalId) => !validSignalId(signalId))) {
      throw new Error('invalid Redis paw-feel signal scan response');
    }
    this.redisCursor = nextRedisCursor;
    this.scanCalls += 1;
    for (const signalId of matches) {
      if (this.pageSet.has(signalId) || this.pendingSet.has(signalId)) continue;
      if (!this.full) this.addToPage(signalId);
      else this.addPending(signalId);
    }
  }

  toPage(): PawFeelSignalScanPage {
    const nextCursor = this.nextCursor();
    return { signalIds: this.signalIds, scanCalls: this.scanCalls, ...(nextCursor ? { nextCursor } : {}) };
  }

  private addToPage(signalId: string): void {
    this.pageSet.add(signalId);
    this.signalIds.push(signalId);
  }

  private addPending(signalId: string): void {
    if (this.pendingSignalIds.length >= PENDING_LIMIT) {
      throw new Error('paw-feel Redis scan overflow exceeds the bounded continuation');
    }
    this.pendingSet.add(signalId);
    this.pendingSignalIds.push(signalId);
  }

  private nextCursor(): PawFeelSignalScanCursorV1 | undefined {
    if (this.redisCursor !== '0') {
      return {
        redisCursor: this.redisCursor,
        pendingSignalIds: this.pendingSignalIds,
        completeAfterPending: false,
      };
    }
    if (this.pendingSignalIds.length === 0) return undefined;
    return { redisCursor: '0', pendingSignalIds: this.pendingSignalIds, completeAfterPending: true };
  }
}

export async function scanPawFeelSignalIds(
  redis: Pick<RedisClient, 'sscan'>,
  redisKey: string,
  rawCursor: PawFeelSignalScanCursorV1 | undefined,
  limit: number,
): Promise<PawFeelSignalScanPage> {
  requireLimit(limit);
  const cursor = rawCursor ? parseCursor(rawCursor) : undefined;
  const accumulator = new SignalScanAccumulator(cursor, limit);
  accumulator.drainPending();
  if (cursor?.completeAfterPending || accumulator.full) return accumulator.toPage();

  while (!accumulator.full && accumulator.scanCalls < SCAN_CALL_LIMIT) {
    const scan = await redis.sscan(redisKey, accumulator.redisCursor, 'COUNT', limit);
    accumulator.addScan(scan[0], scan[1]);
    if (accumulator.redisCursor === '0') break;
  }
  return accumulator.toPage();
}
