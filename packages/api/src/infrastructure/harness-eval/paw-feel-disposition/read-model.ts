import type {
  PawFeelDispositionProjection,
  PawFeelDispositionState,
  PawFeelInboxItem,
  PawFeelInboxPage,
  PawFeelInboxSort,
  PawFeelIssueResolution,
  PawFeelReconciliationCoverage,
  PawFeelResponsibilityProjection,
} from '@cat-cafe/shared';
import { PawFeelBundleSnapshotSigner } from './bundle-snapshot.js';
import type { PawFeelFixResolver } from './command-context.js';
import { PawFeelContinuingResponsibilityResolver } from './continuation/follow-up-resolver.js';
import type { IPawFeelReconciliationCoverageStore } from './coverage-store.js';
import type { PawFeelDutySignalSummary } from './duty-notice.js';
import type { IPawFeelDispositionEventLog } from './event-log.js';
import { loadPawFeelEventMap } from './projection/read-model-events.js';
import { countPawFeelIssues, emptyPawFeelIssueCounts } from './projection/read-model-issue.js';
import { buildPawFeelInboxItem } from './projection/read-model-item.js';
import { loadPawFeelSourceReadScope, type PawFeelReadScope } from './projection/read-model-source-scope.js';
import {
  loadPawFeelReadSourceSnapshots,
  type PawFeelReadSourceSnapshot,
  type PawFeelSourceMessageStore,
  pawFeelSourceIdentityMap,
} from './projection/read-model-source-snapshot.js';
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
import { derivePawFeelCoverageHealth } from './reconciler.js';

export interface PawFeelInboxQuery {
  states?: readonly PawFeelDispositionState[];
  sourceCatId?: string;
  /** Exact identity lookup. Returned aggregates are scoped to this source before applying the other filters. */
  sourceMessageId?: string;
  overdueOnly?: boolean;
  resolution?: PawFeelIssueResolution;
  issueOverdueOnly?: boolean;
  limit?: number;
  cursor?: string;
  sort?: PawFeelInboxSort;
}

export interface PawFeelDispositionReadModelOptions {
  eventLog: IPawFeelDispositionEventLog;
  messageStore: PawFeelSourceMessageStore;
  coverageStore?: Pick<IPawFeelReconciliationCoverageStore, 'read'>;
  proposalStatusResolver?: { isPending(proposalId: string): Promise<boolean> };
  repairBindingResolver?: PawFeelFixResolver;
  bundleSnapshotSigner?: PawFeelBundleSnapshotSigner;
  semanticDegraded?: () => boolean | Promise<boolean>;
  followUpResolver?: Pick<PawFeelContinuingResponsibilityResolver, 'resolve'> &
    Partial<Pick<PawFeelContinuingResponsibilityResolver, 'snapshot'>>;
  now?: () => string;
}

export class PawFeelDispositionReadModel {
  private readonly now: () => string;
  private readonly bundleSnapshotSigner: PawFeelBundleSnapshotSigner;
  private readonly followUpResolver: Pick<PawFeelContinuingResponsibilityResolver, 'resolve'> &
    Partial<Pick<PawFeelContinuingResponsibilityResolver, 'snapshot'>>;

  constructor(private readonly options: PawFeelDispositionReadModelOptions) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.bundleSnapshotSigner = options.bundleSnapshotSigner ?? new PawFeelBundleSnapshotSigner();
    this.followUpResolver = options.followUpResolver ?? new PawFeelContinuingResponsibilityResolver();
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
      const readScope = query.sourceMessageId
        ? await loadPawFeelSourceReadScope(this.options.eventLog, this.options.messageStore, query.sourceMessageId)
        : await this.loadGlobalReadScope();
      const { projections, contextProjections, sourceSnapshots } = readScope;
      const projectionsBySignalId = new Map(contextProjections.map((projection) => [projection.signalId, projection]));
      const sourceIdentitiesBySignalId = pawFeelSourceIdentityMap(sourceSnapshots);
      const followUpResolver = this.followUpResolver.snapshot?.() ?? this.followUpResolver;
      const resolvedItems = await Promise.all(
        projections.map((projection) =>
          this.resolveItem(
            projection,
            projectionsBySignalId,
            sourceIdentitiesBySignalId,
            sourceSnapshots.get(projection.signalId),
            nowMs,
            followUpResolver,
          ),
        ),
      );
      const counts = {
        ...countPawFeelProjections(projections, nowMs),
        overdue: resolvedItems.filter((item) => item.overdue).length,
      };
      const issueCounts = countPawFeelIssues(resolvedItems);
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
        issueCounts,
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
        issueCounts: emptyPawFeelIssueCounts(),
        degraded,
        ...(coverage ? { coverage } : {}),
        unavailableReason: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async listUndispositioned(): Promise<PawFeelDutySignalSummary[]> {
    const nowMs = Date.parse(this.now());
    const projections = await this.loadProjections();
    const projectionsBySignalId = new Map(projections.map((projection) => [projection.signalId, projection]));
    const sourceSnapshots = await loadPawFeelReadSourceSnapshots(this.options.messageStore, projections);
    const sourceIdentitiesBySignalId = pawFeelSourceIdentityMap(sourceSnapshots);
    const followUpResolver = this.followUpResolver.snapshot?.() ?? this.followUpResolver;
    const items = await Promise.all(
      projections.map((projection) =>
        this.resolveItem(
          projection,
          projectionsBySignalId,
          sourceIdentitiesBySignalId,
          sourceSnapshots.get(projection.signalId),
          nowMs,
          followUpResolver,
        ),
      ),
    );
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
    const eventMap = await loadPawFeelEventMap(this.options.eventLog, signalIds);
    return signalIds.map((signalId) => {
      const events = eventMap.get(signalId);
      if (!events || events.length === 0) throw new Error(`signal ${signalId} has no durable events`);
      return projectPawFeelDisposition(events);
    });
  }

  private async loadGlobalReadScope(): Promise<PawFeelReadScope> {
    const projections = await this.loadProjections();
    return {
      projections,
      contextProjections: projections,
      sourceSnapshots: await loadPawFeelReadSourceSnapshots(this.options.messageStore, projections),
    };
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
      (!query.overdueOnly || (!item.responsibility.validExit && item.ageMs >= PAW_FEEL_OVERDUE_MS)) &&
      (!query.resolution || item.issue.resolution === query.resolution) &&
      (!query.issueOverdueOnly || (item.issue.resolution === 'open' && item.issue.ageMs >= PAW_FEEL_OVERDUE_MS))
    );
  }

  private async resolveItem(
    projection: PawFeelDispositionProjection,
    projectionsBySignalId: ReadonlyMap<string, PawFeelDispositionProjection>,
    sourceIdentitiesBySignalId: ReturnType<typeof pawFeelSourceIdentityMap>,
    sourceSnapshot: PawFeelReadSourceSnapshot | undefined,
    nowMs: number,
    followUpResolver: Pick<PawFeelContinuingResponsibilityResolver, 'resolve'>,
  ): Promise<PawFeelInboxItem> {
    const responsibility = await this.resolveResponsibility(projection);
    const issue = await followUpResolver.resolve({
      projection,
      projectionsBySignalId,
      sourceIdentitiesBySignalId,
      nowMs,
    });
    return buildPawFeelInboxItem({ projection, responsibility, issue, sourceSnapshot, nowMs });
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
