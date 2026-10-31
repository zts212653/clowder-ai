import type { PawFeelReconciliationCoverage } from '@cat-cafe/shared';
import type { IMessageStore } from '../../../domains/cats/services/stores/ports/MessageStore.js';
import { getTimelineOrderTime } from '../../../domains/cats/services/stores/visibility.js';
import {
  collectPawFeelMessages,
  inspectDeclaredPawFeelMessage,
  inspectPawFeelMessage,
} from '../friction/paw-feel-source.js';
import type { IPawFeelReconciliationCoverageStore, PawFeelReconciliationKind } from './coverage-store.js';
import type { PawFeelDispositionService } from './service.js';

const DEFAULT_INITIAL_BACKFILL_MS = 7 * 86_400_000;
const DEFAULT_FULL_SCAN_INTERVAL_MS = 86_400_000;
const DEFAULT_OVERLAP_WINDOW_MS = 15 * 60_000;
export const PAW_FEEL_COVERAGE_LAG_THRESHOLD_MS = 30 * 60_000;

export interface PawFeelReconciliationResult {
  mode: PawFeelReconciliationKind;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  scannedMessages: number;
  canonicalSignals: number;
  discoveredSignals: number;
  duplicateSignals: number;
  lagMs: number;
}

export interface PawFeelDispositionReconcilerOptions {
  messageStore: Pick<IMessageStore, 'getBefore'>;
  coverageStore: IPawFeelReconciliationCoverageStore;
  dispositionService: Pick<PawFeelDispositionService, 'discover'>;
  now?: () => string;
  initialBackfillMs?: number;
  fullScanIntervalMs?: number;
  overlapWindowMs?: number;
  pageSize?: number;
}

function requireTimestamp(value: string, name: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(`${name} must be an ISO timestamp`);
  return parsed;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function chooseMode(
  coverage: PawFeelReconciliationCoverage,
  nowMs: number,
  fullScanIntervalMs: number,
): PawFeelReconciliationKind {
  if (!coverage.lastFullScanCompletedAt) return 'full';
  return nowMs - requireTimestamp(coverage.lastFullScanCompletedAt, 'lastFullScanCompletedAt') >= fullScanIntervalMs
    ? 'full'
    : 'overlap';
}

export function derivePawFeelCoverageHealth(
  coverage: PawFeelReconciliationCoverage,
  nowMs = Date.now(),
  lagThresholdMs = PAW_FEEL_COVERAGE_LAG_THRESHOLD_MS,
): PawFeelReconciliationCoverage {
  if (!Number.isFinite(nowMs)) throw new Error('nowMs must be finite');
  if (coverage.status === 'unavailable') return { ...coverage };
  if (!coverage.lastSeenTimelineAt) {
    const { lagMs: _lagMs, ...rest } = coverage;
    return { ...rest, status: 'uninitialized' };
  }
  const lagMs = Math.max(0, nowMs - requireTimestamp(coverage.lastSeenTimelineAt, 'lastSeenTimelineAt'));
  return { ...coverage, status: lagMs > lagThresholdMs ? 'lagging' : 'healthy', lagMs };
}

export class PawFeelDispositionReconciler {
  private readonly now: () => string;
  private readonly initialBackfillMs: number;
  private readonly fullScanIntervalMs: number;
  private readonly overlapWindowMs: number;

  constructor(private readonly options: PawFeelDispositionReconcilerOptions) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.initialBackfillMs = options.initialBackfillMs ?? DEFAULT_INITIAL_BACKFILL_MS;
    this.fullScanIntervalMs = options.fullScanIntervalMs ?? DEFAULT_FULL_SCAN_INTERVAL_MS;
    this.overlapWindowMs = options.overlapWindowMs ?? DEFAULT_OVERLAP_WINDOW_MS;
  }

  async run(): Promise<PawFeelReconciliationResult> {
    const startedAt = this.now();
    const startedAtMs = requireTimestamp(startedAt, 'startedAt');
    let coverage: PawFeelReconciliationCoverage | undefined;
    let mode: PawFeelReconciliationKind | undefined;

    try {
      coverage = await this.options.coverageStore.getOrInitialize(
        new Date(startedAtMs - this.initialBackfillMs).toISOString(),
        startedAt,
      );
      mode = chooseMode(coverage, startedAtMs, this.fullScanIntervalMs);
      await this.options.coverageStore.recordStarted(mode, startedAt);
      return await this.scan(coverage, mode, startedAt, startedAtMs);
    } catch (error) {
      if (coverage && mode) {
        await this.options.coverageStore.recordUnavailable(mode, startedAt, errorMessage(error));
      }
      throw error;
    }
  }

  private async scan(
    coverage: PawFeelReconciliationCoverage,
    mode: PawFeelReconciliationKind,
    startedAt: string,
    startedAtMs: number,
  ): Promise<PawFeelReconciliationResult> {
    const coverageStartMs = requireTimestamp(coverage.coverageStartAt, 'coverageStartAt');
    const previousBoundaryMs = coverage.lastSeenTimelineAt
      ? requireTimestamp(coverage.lastSeenTimelineAt, 'lastSeenTimelineAt')
      : undefined;
    const sinceMs =
      mode === 'full'
        ? coverageStartMs
        : Math.max(coverageStartMs, (previousBoundaryMs ?? startedAtMs) - this.overlapWindowMs);
    const activationMs = coverage.typedCaptureActivatedAt
      ? requireTimestamp(coverage.typedCaptureActivatedAt, 'typedCaptureActivatedAt')
      : startedAtMs;
    const messages = await collectPawFeelMessages(this.options.messageStore, sinceMs, startedAtMs, {
      pageSize: this.options.pageSize,
    });

    let canonicalSignals = 0;
    let discoveredSignals = 0;
    let duplicateSignals = 0;
    for (const message of messages) {
      const inspection =
        getTimelineOrderTime(message) < activationMs
          ? inspectPawFeelMessage(message)
          : inspectDeclaredPawFeelMessage(message);
      if (inspection.kind !== 'canonical') continue;
      canonicalSignals += inspection.candidates.length;
      for (const candidate of inspection.candidates) {
        const candidateAtMs = requireTimestamp(candidate.occurredAt, 'candidate.occurredAt');
        const result = await this.options.dispositionService.discover(candidate, {
          backfilled: candidateAtMs < activationMs,
          captureMethod: 'legacy_parser',
          captureAssessment: 'ambiguous',
        });
        if (result.outcome === 'appended') discoveredSignals += 1;
        else duplicateSignals += 1;
      }
    }

    const completedAt = this.now();
    const completedAtMs = requireTimestamp(completedAt, 'completedAt');
    await this.options.coverageStore.recordSucceeded(mode, startedAt, completedAt, startedAt);
    return {
      mode,
      startedAt,
      completedAt,
      durationMs: Math.max(0, completedAtMs - startedAtMs),
      scannedMessages: messages.length,
      canonicalSignals,
      discoveredSignals,
      duplicateSignals,
      lagMs: Math.max(0, completedAtMs - startedAtMs),
    };
  }
}
