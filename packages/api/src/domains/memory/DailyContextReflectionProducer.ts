import type { ISessionChainStore } from '../cats/services/stores/ports/SessionChainStore.js';
import type { IThreadStore } from '../cats/services/stores/ports/ThreadStore.js';
import type {
  ReflectionSessionSource,
  SessionReflectionProducer,
  SessionReflectionRunResult,
} from './SessionReflectionProducer.js';
import { householdDateKey, previousHouseholdDateKey } from './SessionReflectionProducer.js';

export interface DailyContextReflectionProducerDeps {
  ownerUserId: string;
  threadStore: Pick<IThreadStore, 'list'>;
  sessionChainStore: Pick<ISessionChainStore, 'getChainByThread'>;
  reflectionProducer: Pick<SessionReflectionProducer, 'reflectSessions'>;
  now?: () => number;
  getHouseholdTimeZone?: () => string | undefined;
}

export interface DailyContextReflectionRunResult {
  sourceLocalDate: string;
  sessionsConsidered: number;
  catBatches: number;
  extracted: number;
  accepted: number;
  duplicates: number;
  rejected: number;
  cuesDelivered: number;
  quiet: boolean;
}

export interface DailyContextReflectionRunOptions {
  signal?: AbortSignal;
}

export class DailyContextReflectionProducer {
  private readonly now: () => number;

  constructor(private readonly deps: DailyContextReflectionProducerDeps) {
    if (!deps.ownerUserId.trim()) throw new Error('daily reflection ownerUserId is required');
    this.now = deps.now ?? Date.now;
  }

  async run(options: DailyContextReflectionRunOptions = {}): Promise<DailyContextReflectionRunResult> {
    throwIfAborted(options.signal);
    const timeZone = this.deps.getHouseholdTimeZone?.();
    const sourceLocalDate = previousHouseholdDateKey(this.now(), timeZone);
    const threads = await this.deps.threadStore.list(this.deps.ownerUserId, options);
    throwIfAborted(options.signal);
    const sessionChains = [];
    for (const thread of threads) {
      throwIfAborted(options.signal);
      sessionChains.push(await this.deps.sessionChainStore.getChainByThread(thread.id, options));
      throwIfAborted(options.signal);
    }
    const sessions = sessionChains
      .flat()
      .filter(
        (session) =>
          session.userId === this.deps.ownerUserId &&
          householdDateKey(session.createdAt, timeZone) <= sourceLocalDate &&
          householdDateKey(session.updatedAt, timeZone) >= sourceLocalDate,
      )
      .sort((left, right) => {
        const catOrder = left.catId.localeCompare(right.catId);
        if (catOrder !== 0) return catOrder;
        const timeOrder = (left.sealedAt ?? left.updatedAt) - (right.sealedAt ?? right.updatedAt);
        return timeOrder !== 0 ? timeOrder : left.id.localeCompare(right.id);
      });

    const batches = new Map<string, ReflectionSessionSource[]>();
    for (const session of sessions) {
      const batch = batches.get(session.catId) ?? [];
      batch.push({
        sessionId: session.id,
        ownerUserId: session.userId,
        catId: session.catId,
        threadId: session.threadId,
        sealReason: session.sealReason ?? 'daily_context_reflection',
      });
      batches.set(session.catId, batch);
    }

    const results: SessionReflectionRunResult[] = [];
    for (const batch of batches.values()) {
      throwIfAborted(options.signal);
      results.push(
        await this.deps.reflectionProducer.reflectSessions(batch, {
          sourceLocalDate,
          signal: options.signal,
        }),
      );
    }
    const totals = results.reduce(
      (sum, result) => ({
        extracted: sum.extracted + result.extracted,
        accepted: sum.accepted + result.accepted,
        duplicates: sum.duplicates + result.duplicates,
        rejected: sum.rejected + result.rejected,
        cuesDelivered: sum.cuesDelivered + result.cuesDelivered,
      }),
      { extracted: 0, accepted: 0, duplicates: 0, rejected: 0, cuesDelivered: 0 },
    );

    return {
      sourceLocalDate,
      sessionsConsidered: sessions.length,
      catBatches: batches.size,
      ...totals,
      quiet: totals.accepted === 0 && totals.rejected === 0 && totals.cuesDelivered === 0,
    };
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  signal?.throwIfAborted();
}
