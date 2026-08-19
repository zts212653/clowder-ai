import type {
  PawFeelDispositionEvent,
  PawFeelDispositionProjection,
  PawFeelDispositionState,
  PawFeelInboxItem,
  PawFeelInboxPage,
  PawFeelInboxSort,
  PawFeelReconciliationCoverage,
  PawFeelResponsibilityProjection,
} from '@cat-cafe/shared';
import type { IMessageStore, StoredMessage } from '../../../domains/cats/services/stores/ports/MessageStore.js';
import { inspectPawFeelMessage } from '../friction/paw-feel-source.js';
import { PawFeelBundleSnapshotSigner } from './bundle-snapshot.js';
import type { PawFeelFixResolver } from './command-context.js';
import type { IPawFeelReconciliationCoverageStore } from './coverage-store.js';
import type { PawFeelDutySignalSummary } from './duty-notice.js';
import type { IPawFeelDispositionEventLog } from './event-log.js';
import { projectPawFeelDisposition } from './projector.js';
import {
  derivePawFeelBundles,
  derivePawFeelDenominator,
  derivePawFeelResponsibility,
  emptyBundleCounts,
  emptyDenominator,
  emptyResponsibilityCounts,
  filterPawFeelBundles,
} from './read-model-bundles.js';
import {
  countPawFeelProjections,
  emptyPawFeelInboxCounts,
  PAW_FEEL_OVERDUE_MS,
  paginatePawFeelBundles,
} from './read-model-pagination.js';
import {
  availablePawFeelSourceHref,
  clampPawFeelPreview,
  pawFeelResponsibilityAge,
  unavailablePawFeelItem,
} from './read-model-source.js';
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
  proposalStatusResolver?: { isPending(proposalId: string): Promise<boolean> };
  repairBindingResolver?: PawFeelFixResolver;
  bundleSnapshotSigner?: PawFeelBundleSnapshotSigner;
  semanticDegraded?: () => boolean | Promise<boolean>;
  now?: () => string;
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
  private readonly bundleSnapshotSigner: PawFeelBundleSnapshotSigner;

  constructor(private readonly options: PawFeelDispositionReadModelOptions) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.bundleSnapshotSigner = options.bundleSnapshotSigner ?? new PawFeelBundleSnapshotSigner();
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
      const resolvedItems = await Promise.all(projections.map((projection) => this.resolveItem(projection, nowMs)));
      const counts = {
        ...countPawFeelProjections(projections, nowMs),
        overdue: resolvedItems.filter((item) => item.overdue).length,
      };
      const allBundleProjection = derivePawFeelBundles(resolvedItems);
      const responsibilityCounts = emptyResponsibilityCounts();
      for (const bundle of allBundleProjection.bundles) responsibilityCounts[bundle.responsibility.state] += 1;
      const denominator = derivePawFeelDenominator(projections, allBundleProjection.counts.total);
      const filteredBundlesWithStableIdentity = filterPawFeelBundles(allBundleProjection.bundles, (item) =>
        this.itemMatches(item, query),
      );
      const paginated = paginatePawFeelBundles(filteredBundlesWithStableIdentity, query);
      const bundles = paginated.bundles.map((bundle) => ({
        ...bundle,
        membershipToken: this.signBundleSnapshot(bundle.bundleKey, bundle.members),
      }));
      const { nextCursor } = paginated;
      const items = bundles.flatMap((bundle) => bundle.members);
      return {
        generatedAt,
        projectionStatus: 'available',
        items,
        bundles,
        bundleCounts: allBundleProjection.counts,
        denominator,
        counts,
        responsibilityCounts,
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
        responsibilityCounts: emptyResponsibilityCounts(),
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
    return items
      .filter((item) => !item.responsibility.validExit)
      .map((item) => {
        const projection = item.disposition;
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
          responsibility: item.responsibility,
        };
      });
  }

  async readResponsibilities(
    signalIds: readonly string[],
  ): Promise<Array<{ signalId: string; sequence: number; responsibility: PawFeelInboxItem['responsibility'] }>> {
    const requested = new Set(signalIds);
    const projections = await this.loadProjections();
    const selected = projections.filter((projection) => requested.has(projection.signalId));
    if (selected.length !== requested.size) {
      const found = new Set(selected.map((projection) => projection.signalId));
      const missing = signalIds.find((signalId) => !found.has(signalId));
      throw new Error(`duty receipt signal ${missing ?? 'unknown'} is no longer available`);
    }
    return Promise.all(
      selected.map(async (projection) => ({
        signalId: projection.signalId,
        sequence: projection.sequence,
        responsibility: await this.resolveResponsibility(projection),
      })),
    );
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

  async assertBundleSnapshot(
    bundleKey: string,
    members: readonly { signalId: string; expectedSequence: number }[],
    membershipToken: string,
  ): Promise<void> {
    this.bundleSnapshotSigner.assert(bundleKey, members, membershipToken);
  }

  private signBundleSnapshot(bundleKey: string, members: readonly PawFeelInboxItem[]): string {
    return this.bundleSnapshotSigner.sign(
      bundleKey,
      members.map((member) => ({
        signalId: member.disposition.signalId,
        expectedSequence: member.disposition.sequence,
      })),
    );
  }

  private itemMatches(item: PawFeelInboxItem, query: PawFeelInboxQuery): boolean {
    const stateFilter = query.states ? new Set(query.states) : undefined;
    const projection = item.disposition;
    return (
      (!stateFilter || stateFilter.has(projection.state)) &&
      (!query.sourceCatId || projection.sourceCatId === query.sourceCatId) &&
      (!query.sourceMessageId || projection.sourceMessageId === query.sourceMessageId) &&
      (!query.overdueOnly || (!item.responsibility.validExit && item.ageMs >= PAW_FEEL_OVERDUE_MS))
    );
  }

  private async resolveItem(projection: PawFeelDispositionProjection, nowMs: number): Promise<PawFeelInboxItem> {
    const responsibility = await this.resolveResponsibility(projection);
    let message: StoredMessage | null;
    try {
      message = await this.options.messageStore.getById(projection.sourceMessageId);
    } catch {
      return unavailablePawFeelItem(projection, responsibility, nowMs, 'source read failed');
    }
    if (!message) {
      return unavailablePawFeelItem(projection, responsibility, nowMs, 'source message unavailable');
    }
    const inspection = inspectPawFeelMessage(message);
    const sourceMarkerCount = inspection.kind === 'canonical' ? inspection.candidates.length : 0;
    const candidate =
      inspection.kind === 'canonical'
        ? inspection.candidates.find((entry) => entry.signalId === projection.signalId)
        : undefined;
    if (!candidate || candidate.markerDigest !== projection.markerDigest) {
      return unavailablePawFeelItem(projection, responsibility, nowMs, 'source digest mismatch');
    }
    const preview = clampPawFeelPreview(
      candidate.marker.tool ? `${candidate.marker.tool} · ${candidate.marker.symptom}` : candidate.marker.symptom,
    );
    const deterministicGroupKey = candidate.marker.tool
      ? `tool:${candidate.marker.tool.trim().toLowerCase()}`
      : undefined;
    const ageMs = pawFeelResponsibilityAge(projection, responsibility, nowMs);
    return {
      disposition: projection,
      responsibility,
      source: {
        availability: 'available',
        preview,
        sourceHref: availablePawFeelSourceHref(projection),
        digestVerified: true,
      },
      sourceOccurredAt: candidate.occurredAt,
      ageMs,
      overdue: !responsibility.validExit && ageMs >= PAW_FEEL_OVERDUE_MS,
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

  private async resolveResponsibility(
    projection: PawFeelDispositionProjection,
  ): Promise<PawFeelResponsibilityProjection> {
    if (projection.state === 'fix') {
      const leaseRef = projection.actionLeaseRef;
      if (!leaseRef) return derivePawFeelResponsibility(projection);
      try {
        const current = await this.options.repairBindingResolver?.resolve(leaseRef.leaseId);
        const matches = Boolean(
          current &&
            current.ownerCatId === projection.ownerCatId &&
            current.taskId === projection.taskId &&
            current.leaseId === leaseRef.leaseId &&
            current.leaseGeneration === leaseRef.generation &&
            current.custodyEvidenceRef === projection.custodyEvidenceRef,
        );
        return derivePawFeelResponsibility(projection, { repairBindingIsActive: matches });
      } catch {
        return derivePawFeelResponsibility(projection);
      }
    }
    if (projection.state === 'route_pending' && projection.proposalId) {
      try {
        const pending = (await this.options.proposalStatusResolver?.isPending(projection.proposalId)) ?? false;
        return derivePawFeelResponsibility(projection, { proposalIsPending: pending });
      } catch {
        return derivePawFeelResponsibility(projection);
      }
    }
    return derivePawFeelResponsibility(projection);
  }

  private async resolveDegraded(): Promise<boolean> {
    try {
      return (await this.options.semanticDegraded?.()) ?? false;
    } catch {
      return true;
    }
  }
}
