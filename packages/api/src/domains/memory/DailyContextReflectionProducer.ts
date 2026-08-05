import { performance } from 'node:perf_hooks';
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
  monotonicNow?: () => number;
  getHouseholdTimeZone?: () => string | undefined;
}

export interface DailyContextReflectionTelemetry {
  threadCount: number;
  threadListMs: number;
  sessionScanMs: number;
  reflectionMs: number;
  totalMs: number;
  activeWorkAtEnd: number;
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
  telemetry: DailyContextReflectionTelemetry;
}

export interface DailyContextReflectionRunOptions {
  signal?: AbortSignal;
}

export class DailyContextReflectionProducer {
  private readonly now: () => number;
  private readonly monotonicNow: () => number;

  constructor(private readonly deps: DailyContextReflectionProducerDeps) {
    if (!deps.ownerUserId.trim()) throw new Error('daily reflection ownerUserId is required');
    this.now = deps.now ?? Date.now;
    this.monotonicNow = deps.monotonicNow ?? performance.now.bind(performance);
  }

  async run(options: DailyContextReflectionRunOptions = {}): Promise<DailyContextReflectionRunResult> {
    throwIfAborted(options.signal);
    const startedAt = this.monotonicNow();
    let activeWork = 0;
    const trackWork = async <T>(work: () => T | Promise<T>): Promise<T> => {
      activeWork += 1;
      try {
        return await work();
      } finally {
        activeWork -= 1;
      }
    };
    const timeZone = this.deps.getHouseholdTimeZone?.();
    const sourceLocalDate = previousHouseholdDateKey(this.now(), timeZone);
    const threads = await trackWork(() => this.deps.threadStore.list(this.deps.ownerUserId, options));
    const threadListMs = elapsedMs(startedAt, this.monotonicNow());
    throwIfAborted(options.signal);
    const sessionScanStartedAt = this.monotonicNow();
    const sessionChains = [];
    for (const thread of threads) {
      throwIfAborted(options.signal);
      sessionChains.push(await trackWork(() => this.deps.sessionChainStore.getChainByThread(thread.id, options)));
      throwIfAborted(options.signal);
    }
    const sessionScanMs = elapsedMs(sessionScanStartedAt, this.monotonicNow());
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

    const reflectionStartedAt = this.monotonicNow();
    const results: SessionReflectionRunResult[] = [];
    for (const batch of batches.values()) {
      throwIfAborted(options.signal);
      results.push(
        await trackWork(() =>
          this.deps.reflectionProducer.reflectSessions(batch, {
            sourceLocalDate,
            signal: options.signal,
          }),
        ),
      );
    }
    const reflectionMs = elapsedMs(reflectionStartedAt, this.monotonicNow());
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
      telemetry: {
        threadCount: threads.length,
        threadListMs,
        sessionScanMs,
        reflectionMs,
        totalMs: elapsedMs(startedAt, this.monotonicNow()),
        activeWorkAtEnd: activeWork,
      },
    };
  }
}

function elapsedMs(startedAt: number, completedAt: number): number {
  return Math.max(0, Math.round(completedAt - startedAt));
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  signal?.throwIfAborted();
}
