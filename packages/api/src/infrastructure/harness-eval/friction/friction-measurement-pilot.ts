import type { FrictionRollupSourceSelector, FrictionSignal } from '@cat-cafe/shared';
import type { IFrustrationIssueStore } from '../../../domains/cats/services/stores/ports/FrustrationIssueStore.js';
import type { IMessageStore } from '../../../domains/cats/services/stores/ports/MessageStore.js';
import type { IEmbeddingService } from '../../../domains/memory/interfaces.js';
import type { StoredSignal, TaskOutcomeEpisodeStore } from '../task-outcome/task-outcome-store.js';
import { CancelAdapter } from './cancel-adapter.js';
import { EvalDomainAdapter } from './eval-domain-adapter.js';
import { FrictionAggregator } from './friction-aggregator.js';
import { FrictionClusterer } from './friction-clusterer.js';
import type { FrictionChannelCapture, FrictionMeasurementCapture } from './friction-measurement-report.js';
import { buildFrictionRollupInput } from './friction-rollup-input.js';
import { buildFrictionRollupReport } from './friction-rollup-report.js';
import type { IFrictionSignalSource } from './friction-signal-source.js';
import { PawFeelAdapter } from './paw-feel-adapter.js';
import { UserFeedbackAdapter } from './user-feedback-adapter.js';

export type {
  FrictionChannelCapture,
  FrictionChannelFunnel,
  FrictionMeasurementCapture,
  FrictionMeasurementReport,
} from './friction-measurement-report.js';
export { buildFrictionMeasurementReport } from './friction-measurement-report.js';

const CANCEL_CATEGORIES: Array<'a1' | 'a2' | 'proxy'> = ['a2', 'proxy'];
const CANCEL_TYPES: ReadonlySet<unknown> = new Set(['permission_cancel', 'cancel_burst']);
const FRICTION_SELF_EXCLUDE_FEATURE_IDS: ReadonlySet<string> = new Set(['F245']);

type CapturedSource =
  | { source: IFrictionSignalSource; status: 'fulfilled'; signals: FrictionSignal[] }
  | { source: IFrictionSignalSource; status: 'rejected' };

export interface FrictionMeasurementPilotDeps {
  messageStore: Pick<IMessageStore, 'getBefore'>;
  taskOutcomeStore: Pick<TaskOutcomeEpisodeStore, 'listSignalsInWindow'>;
  frustrationIssueStore: Pick<IFrustrationIssueStore, 'listConfirmedInWindow'>;
  harnessFeedbackRoot: string;
  embeddingService?: IEmbeddingService;
  now?: () => number;
}

export async function captureFrictionMeasurementPilot(
  deps: FrictionMeasurementPilotDeps,
  selector: FrictionRollupSourceSelector,
): Promise<FrictionMeasurementCapture> {
  const capturedAtMs = deps.now?.() ?? Date.now();
  assertClosedWindow(selector, capturedAtMs);

  const sinceMs = selector.windowStartMs;
  const untilMs = selector.windowEndMs;
  const frozenRows = freezeRows(deps.taskOutcomeStore.listSignalsInWindow(sinceMs, untilMs, CANCEL_CATEGORIES));
  const sources = buildSources(deps, frozenStore(frozenRows, sinceMs, untilMs));
  const capturedSources = await Promise.all(sources.map((source) => captureSource(source, sinceMs, untilMs)));
  const channelCaptures = captureOutcomes(capturedSources);
  const aggregator = new FrictionAggregator(replaySources(capturedSources));
  const clusterer = new FrictionClusterer(deps.embeddingService);
  const rollupInput = await buildFrictionRollupInput(aggregator, clusterer, sinceMs, untilMs);
  const capturedAt = new Date(capturedAtMs).toISOString();
  const rollupReport = buildFrictionRollupReport(rollupInput, capturedAt, {
    ...(selector.topN !== undefined ? { topN: selector.topN } : {}),
    ...(selector.tokenCap !== undefined ? { tokenCap: selector.tokenCap } : {}),
  });

  return {
    capturedAt,
    expectedCancelIds: expectedCancelIds(frozenRows),
    channelCaptures,
    rollupInput,
    rollupReport,
  };
}

function assertClosedWindow(selector: FrictionRollupSourceSelector, capturedAtMs: number): void {
  if (
    !Number.isFinite(selector.windowStartMs) ||
    !Number.isFinite(selector.windowEndMs) ||
    !Number.isFinite(capturedAtMs) ||
    selector.windowStartMs >= selector.windowEndMs ||
    selector.windowEndMs > capturedAtMs
  ) {
    throw new Error('friction_pilot_window_not_closed');
  }
}

function buildSources(
  deps: FrictionMeasurementPilotDeps,
  taskOutcomeStore: Pick<TaskOutcomeEpisodeStore, 'listSignalsInWindow'>,
): IFrictionSignalSource[] {
  return [
    new PawFeelAdapter(deps.messageStore),
    new CancelAdapter(taskOutcomeStore),
    new UserFeedbackAdapter(deps.frustrationIssueStore),
    new EvalDomainAdapter(deps.harnessFeedbackRoot, { excludeFeatureIds: FRICTION_SELF_EXCLUDE_FEATURE_IDS }),
  ];
}

function frozenStore(
  rows: StoredSignal[],
  expectedSinceMs: number,
  expectedUntilMs: number,
): Pick<TaskOutcomeEpisodeStore, 'listSignalsInWindow'> {
  return {
    listSignalsInWindow(sinceMs, untilMs, categories) {
      if (
        sinceMs !== expectedSinceMs ||
        untilMs !== expectedUntilMs ||
        !categories ||
        categories.length !== CANCEL_CATEGORIES.length ||
        categories.some((category, index) => category !== CANCEL_CATEGORIES[index])
      ) {
        throw new Error('friction_pilot_frozen_store_contract_violation');
      }
      return rows;
    },
  };
}

function freezeRows(rows: StoredSignal[]): StoredSignal[] {
  return Object.freeze(
    rows.map((row) =>
      Object.freeze({
        ...row,
        record: Object.freeze({ ...row.record }),
      }),
    ),
  ) as unknown as StoredSignal[];
}

function expectedCancelIds(rows: StoredSignal[]): string[] {
  return rows
    .filter((row) => CANCEL_TYPES.has(row.record.type))
    .map((row) => `cancel:${row.id}`)
    .sort();
}

async function captureSource(source: IFrictionSignalSource, sinceMs: number, untilMs: number): Promise<CapturedSource> {
  try {
    return { source, status: 'fulfilled', signals: await source.pull(sinceMs, untilMs) };
  } catch {
    return { source, status: 'rejected' };
  }
}

function captureOutcomes(capturedSources: CapturedSource[]): FrictionMeasurementCapture['channelCaptures'] {
  const result = {} as FrictionMeasurementCapture['channelCaptures'];
  for (const captured of capturedSources) {
    const capture: FrictionChannelCapture =
      captured.status === 'fulfilled'
        ? { status: 'ok', emittedIds: sortedUnique(captured.signals.map((signal) => signal.id)) }
        : { status: 'error', emittedIds: [], errorCode: 'source_pull_failed' };
    result[captured.source.channelId] = capture;
  }
  return result;
}

function replaySources(capturedSources: CapturedSource[]): IFrictionSignalSource[] {
  return capturedSources.map((captured) => ({
    channelId: captured.source.channelId,
    async pull() {
      if (captured.status === 'rejected') throw new Error('captured_source_pull_failed');
      return captured.signals;
    },
  }));
}

function sortedUnique(ids: string[]): string[] {
  return [...new Set(ids)].sort();
}
