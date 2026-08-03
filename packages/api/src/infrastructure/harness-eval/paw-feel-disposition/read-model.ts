import type {
  PawFeelDispositionEvent,
  PawFeelDispositionProjection,
  PawFeelDispositionState,
  PawFeelInboxItem,
  PawFeelInboxPage,
  PawFeelInboxSort,
  PawFeelReconciliationCoverage,
  PawFeelSourceResolution,
} from '@cat-cafe/shared';
import type { IMessageStore, StoredMessage } from '../../../domains/cats/services/stores/ports/MessageStore.js';
import { inspectPawFeelMessage } from '../friction/paw-feel-source.js';
import type { IPawFeelReconciliationCoverageStore } from './coverage-store.js';
import type { PawFeelDutySignalSummary } from './duty-notice.js';
import type { IPawFeelDispositionEventLog } from './event-log.js';
import { projectPawFeelDisposition } from './projector.js';
import {
  derivePawFeelBundles,
  derivePawFeelDenominator,
  emptyBundleCounts,
  emptyDenominator,
  filterPawFeelBundles,
} from './read-model-bundles.js';
import {
  countPawFeelProjections,
  emptyPawFeelInboxCounts,
  isTerminalPawFeelState,
  PAW_FEEL_OVERDUE_MS,
  paginatePawFeelBundles,
  pawFeelAge,
} from './read-model-pagination.js';
import { derivePawFeelCoverageHealth } from './reconciler.js';

export interface PawFeelInboxQuery {
  states?: readonly PawFeelDispositionState[];
  sourceCatId?: string;
  sourceMessageId?: string;
  overdueOnly?: boolean;
  limit?: number;
  cursor?: string;
  sort?: PawFeelInboxSort;
}

export interface PawFeelDispositionReadModelOptions {
  eventLog: IPawFeelDispositionEventLog;
  messageStore: Pick<IMessageStore, 'getById'>;
  coverageStore?: Pick<IPawFeelReconciliationCoverageStore, 'read'>;
  semanticDegraded?: () => boolean | Promise<boolean>;
  now?: () => string;
}

function sourceHref(projection: PawFeelDispositionProjection): string {
  return `/thread/${encodeURIComponent(projection.sourceThreadId)}?message=${encodeURIComponent(
    projection.sourceMessageId,
  )}`;
}

function clampPreview(value: string): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized.length <= 240 ? normalized : `${normalized.slice(0, 237)}…`;
}

function unavailableSource(projection: PawFeelDispositionProjection, reason: string): PawFeelSourceResolution {
  return { availability: 'unavailable', reason, sourceHref: sourceHref(projection) };
}

function unavailableItem(projection: PawFeelDispositionProjection, nowMs: number, reason: string): PawFeelInboxItem {
  const ageMs = pawFeelAge(projection, nowMs);
  return {
    disposition: projection,
    source: unavailableSource(projection, reason),
    ageMs,
    overdue: !isTerminalPawFeelState(projection.state) && ageMs >= PAW_FEEL_OVERDUE_MS,
  };
}

async function loadEventMap(
  eventLog: IPawFeelDispositionEventLog,
  signalIds: readonly string[],
): Promise<Map<string, PawFeelDispositionEvent[]>> {
  if (eventLog.readMany) return eventLog.readMany(signalIds);
  const result = new Map<string, PawFeelDispositionEvent[]>();
  for (let offset = 0; offset < signalIds.length; offset += 50) {
    const batch = signalIds.slice(offset, offset + 50);
    const events = await Promise.all(batch.map((signalId) => eventLog.read(signalId)));
    for (let index = 0; index < batch.length; index += 1) {
      const signalId = batch[index];
      const signalEvents = events[index];
      if (signalId && signalEvents) result.set(signalId, signalEvents);
    }
  }
  return result;
}

export class PawFeelDispositionReadModel {
  private readonly now: () => string;

  constructor(private readonly options: PawFeelDispositionReadModelOptions) {
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async list(query: PawFeelInboxQuery = {}): Promise<PawFeelInboxPage> {
    const generatedAt = this.now();
    const nowMs = Date.parse(generatedAt);
    if (!Number.isFinite(nowMs)) throw new Error(`invalid read-model time: ${generatedAt}`);
    const degraded = await this.resolveDegraded();
    let coverage: PawFeelReconciliationCoverage | undefined;
    try {
      const storedCoverage = await this.options.coverageStore?.read();
      if (storedCoverage) coverage = derivePawFeelCoverageHealth(storedCoverage, nowMs);
      const projections = await this.loadProjections();
      const counts = countPawFeelProjections(projections, nowMs);
      const resolvedItems = await Promise.all(projections.map((projection) => this.resolveItem(projection, nowMs)));
      const allBundleProjection = derivePawFeelBundles(resolvedItems);
      const denominator = derivePawFeelDenominator(projections, allBundleProjection.counts.total);
      const filteredBundlesWithStableIdentity = filterPawFeelBundles(allBundleProjection.bundles, (item) =>
        this.itemMatches(item, query, nowMs),
      );
      const { bundles, nextCursor } = paginatePawFeelBundles(filteredBundlesWithStableIdentity, query);
      const items = bundles.flatMap((bundle) => bundle.members);
      return {
        generatedAt,
        projectionStatus: 'available',
        items,
        bundles,
        bundleCounts: allBundleProjection.counts,
        denominator,
        counts,
        ...(nextCursor ? { nextCursor } : {}),
        degraded,
        ...(coverage ? { coverage } : {}),
      };
    } catch (error) {
      return {
        generatedAt,
        projectionStatus: 'unavailable',
        items: [],
        bundles: [],
        bundleCounts: emptyBundleCounts(),
        denominator: emptyDenominator(),
        counts: emptyPawFeelInboxCounts(),
        degraded,
        ...(coverage ? { coverage } : {}),
        unavailableReason: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async listUndispositioned(): Promise<PawFeelDutySignalSummary[]> {
    const nowMs = Date.parse(this.now());
    const projections = await this.loadProjections();
    const items = await Promise.all(projections.map((projection) => this.resolveItem(projection, nowMs)));
    const bundleKeyBySignal = new Map<string, string>();
    for (const bundle of derivePawFeelBundles(items).bundles) {
      for (const member of bundle.members) {
        bundleKeyBySignal.set(member.disposition.signalId, bundle.bundleKey);
      }
    }
    return projections
      .filter(
        (
          projection,
        ): projection is PawFeelDispositionProjection & {
          state: 'new' | 'seen' | 'route_pending';
        } => !isTerminalPawFeelState(projection.state),
      )
      .map((projection) => {
        const bundleKey = bundleKeyBySignal.get(projection.signalId);
        if (!bundleKey) throw new Error(`active paw-feel signal ${projection.signalId} has no review bundle`);
        return {
          signalId: projection.signalId,
          bundleKey,
          sourceMessageId: projection.sourceMessageId,
          state: projection.state,
          sequence: projection.sequence,
          discoveredAt: projection.discoveredAt,
          lastTransitionAt: projection.lastTransitionAt,
        };
      });
  }

  private async loadProjections(): Promise<PawFeelDispositionProjection[]> {
    const signalIds = await this.options.eventLog.listSignalIds();
    const eventMap = await loadEventMap(this.options.eventLog, signalIds);
    return signalIds.map((signalId) => {
      const events = eventMap.get(signalId);
      if (!events || events.length === 0) throw new Error(`signal ${signalId} has no durable events`);
      return projectPawFeelDisposition(events);
    });
  }

  async assertBundleMembers(bundleKey: string, signalIds: readonly string[]): Promise<void> {
    const nowMs = Date.parse(this.now());
    const projections = await this.loadProjections();
    const items = await Promise.all(projections.map((projection) => this.resolveItem(projection, nowMs)));
    const bundle = derivePawFeelBundles(items).bundles.find((entry) => entry.bundleKey === bundleKey);
    const authoritative = new Set(bundle?.members.map((member) => member.disposition.signalId) ?? []);
    const mismatched = signalIds.find((signalId) => !authoritative.has(signalId));
    if (!bundle || mismatched) {
      throw new Error(
        mismatched
          ? `signal ${mismatched} is not a member of bundle ${bundleKey}`
          : `bundle ${bundleKey} is not available`,
      );
    }
  }

  private itemMatches(item: PawFeelInboxItem, query: PawFeelInboxQuery, nowMs: number): boolean {
    const stateFilter = query.states ? new Set(query.states) : undefined;
    const projection = item.disposition;
    return (
      (!stateFilter || stateFilter.has(projection.state)) &&
      (!query.sourceCatId || projection.sourceCatId === query.sourceCatId) &&
      (!query.sourceMessageId || projection.sourceMessageId === query.sourceMessageId) &&
      (!query.overdueOnly ||
        (!isTerminalPawFeelState(projection.state) && pawFeelAge(projection, nowMs) >= PAW_FEEL_OVERDUE_MS))
    );
  }

  private async resolveItem(projection: PawFeelDispositionProjection, nowMs: number): Promise<PawFeelInboxItem> {
    let message: StoredMessage | null;
    try {
      message = await this.options.messageStore.getById(projection.sourceMessageId);
    } catch {
      return unavailableItem(projection, nowMs, 'source read failed');
    }
    if (!message) {
      return unavailableItem(projection, nowMs, 'source message unavailable');
    }
    const inspection = inspectPawFeelMessage(message);
    const sourceMarkerCount = inspection.kind === 'canonical' ? inspection.candidates.length : 0;
    const candidate =
      inspection.kind === 'canonical'
        ? inspection.candidates.find((entry) => entry.signalId === projection.signalId)
        : undefined;
    if (!candidate || candidate.markerDigest !== projection.markerDigest) {
      return unavailableItem(projection, nowMs, 'source digest mismatch');
    }
    const preview = clampPreview(
      candidate.marker.tool ? `${candidate.marker.tool} · ${candidate.marker.symptom}` : candidate.marker.symptom,
    );
    const deterministicGroupKey = candidate.marker.tool
      ? `tool:${candidate.marker.tool.trim().toLowerCase()}`
      : undefined;
    return {
      disposition: projection,
      source: {
        availability: 'available',
        preview,
        sourceHref: sourceHref(projection),
        digestVerified: true,
      },
      sourceOccurredAt: candidate.occurredAt,
      ageMs: pawFeelAge(projection, nowMs),
      overdue: !isTerminalPawFeelState(projection.state) && pawFeelAge(projection, nowMs) >= PAW_FEEL_OVERDUE_MS,
      reviewContext: {
        sourceMarkerCount,
        ...(message.extra?.stream?.turnInvocationId ? { turnInvocationId: message.extra.stream.turnInvocationId } : {}),
        ...(!message.extra?.stream?.turnInvocationId && message.extra?.stream?.invocationId
          ? { legacyInvocationId: message.extra.stream.invocationId }
          : {}),
      },
      ...(deterministicGroupKey ? { deterministicGroupKey } : {}),
    };
  }

  private async resolveDegraded(): Promise<boolean> {
    try {
      return (await this.options.semanticDegraded?.()) ?? false;
    } catch {
      return true;
    }
  }
}
