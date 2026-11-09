import { createHash, randomUUID } from 'node:crypto';
import {
  cueEnvelopeV1Schema,
  RECALL_OPPORTUNITY_CATALOG_VERSION,
  type RecallOpportunityV1,
  type RecallScopeV1,
} from '@cat-cafe/shared';
import { estimateTokens } from '../../../../utils/token-counter.js';
import type { InvocationRecord } from '../../../cats/services/agents/invocation/InvocationRegistry.js';
import { KnowledgeResolver } from '../../KnowledgeResolver.js';
import { checkDiscoveryLifetime, type KnowledgeDiscoverySource } from '../../knowledge-discovery.js';
import { ContextSourceWorkBudget } from '../ContextSourceWorkBudget.js';
import type { MemoryCueDrillCoordinate, MemoryCueDrillHandleService } from '../MemoryCueDrillHandleService.js';
import type { MemoryCueEpisodeStore, MemoryCueInvalidationReason } from '../MemoryCueEpisodeStore.js';
import { buildCueEnvelope } from '../MemoryCueResolverRegistry.js';
import type { MemoryCueSourceReader } from '../MemoryCueSourceReader.js';
import { getRecallOpportunityCatalogEntry } from '../RecallOpportunityCatalog.js';
import { PreparationSourceObservations } from './preparation-source-observation.js';
import type { PreparationSource } from './project-preparation-source.js';
import type { WorkPreparationAuthority } from './WorkPreparationAuthority.js';
import type {
  PreparedCoordinate,
  WorkPreparationOpportunityStore,
  WorkPreparationRecord,
} from './WorkPreparationOpportunityStore.js';
import {
  preparationFailureFields,
  type WorkPreparationLogger,
  type WorkPreparationStage,
} from './work-preparation-diagnostics.js';

export interface PreparationDiscoveryInput {
  record: WorkPreparationRecord;
  query: string;
  signal: AbortSignal;
  deadlineAt?: number;
  observations?: PreparationSourceObservations;
}
export interface WorkPreparationSources {
  create(input: PreparationDiscoveryInput): Promise<KnowledgeDiscoverySource<unknown, PreparationSource>[]>;
  read(
    record: WorkPreparationRecord,
    request: Parameters<MemoryCueSourceReader['read']>[0],
    prepared: PreparedCoordinate,
  ): ReturnType<MemoryCueSourceReader['read']>;
}

export class WorkPreparationService {
  constructor(
    private readonly deps: {
      authority: Pick<WorkPreparationAuthority, 'bind' | 'validate'>;
      store: WorkPreparationOpportunityStore;
      episodes: MemoryCueEpisodeStore;
      handles: MemoryCueDrillHandleService;
      sources: WorkPreparationSources;
      logger?: WorkPreparationLogger;
    },
  ) {}

  async prepare(input: {
    auth: InvocationRecord;
    activity: 'html' | 'video';
    query: string;
    receivedAt: number;
    signal: AbortSignal;
    deadlineAt?: number;
  }) {
    const empty = (status: string) => ({ status, delivery: 'unknown' as const, pointers: [] });
    const deadlineAt = Math.min(Date.now() + 1500, input.deadlineAt ?? Infinity);
    const budget = new ContextSourceWorkBudget(Math.max(0, deadlineAt - Date.now()));
    const check = () => checkDiscoveryLifetime({ signal: input.signal, deadlineAt });
    const started = performance.now();
    const observations = new PreparationSourceObservations();
    let stage: WorkPreparationStage = 'bind';
    let stageStarted = started;
    const enter = (next: WorkPreparationStage) => {
      check();
      stage = next;
      stageStarted = performance.now();
    };
    const discoveryQuery = `${input.activity} ${input.query}`;
    let received: WorkPreparationRecord | undefined;
    try {
      check();
      const binding = await budget.run(
        (signal) => this.deps.authority.bind(input.auth, { signal, deadlineAt: deadlineAt - 200 }),
        200,
        input.signal,
      );
      check();
      if (!binding) return empty('not_available');
      const opportunity = {
        v: 1 as const,
        kind: 'work_preparation' as const,
        producer: 'explicit_preparation' as const,
        consumer: 'agent_route' as const,
        opportunityId: `preparation-${randomUUID()}`,
        scope: binding.scope,
        occurredAt: input.receivedAt,
        payload: {
          activity: input.activity,
          query: input.query,
          contextEpoch: binding.contextEpoch,
          sourceMessageId: binding.sourceMessageId,
        },
      };
      const entry = getRecallOpportunityCatalogEntry(opportunity);
      const queryDigest = createHash('sha256')
        .update(input.query.normalize('NFKC').toLowerCase().replace(/\s+/gu, ' ').trim())
        .digest('hex');
      enter('receive');
      const record = this.deps.store.receive({
        ...binding,
        opportunityId: opportunity.opportunityId,
        activity: input.activity,
        queryDigest,
        occurredAt: input.receivedAt,
        expiresAt: input.receivedAt + entry.expiresAfterMs,
      });
      received = record;
      enter('create');
      const sources = await budget.run(
        (signal) =>
          this.deps.sources.create({
            record,
            query: discoveryQuery,
            signal,
            deadlineAt: deadlineAt - 200,
            observations,
          }),
        200,
        input.signal,
      );
      check();
      enter('source_metadata');
      this.deps.store.recordSources(
        record.opportunityId,
        sources.map((source) => source.id),
      );
      const keepUnknown = (item: PreparationSource | null) =>
        item &&
        !this.deps.store.wasConsumed(record, {
          resolverFamily: item.family,
          anchor: item.source.anchor,
          revision: item.source.revision,
          catalogVersion: RECALL_OPPORTUNITY_CATALOG_VERSION,
          resolverVersion: item.resolverVersion ?? 1,
        })
          ? item
          : null;
      const eligible = sources.map((source) => ({
        ...source,
        project: async (candidate: unknown) => keepUnknown(await source.project(candidate)),
        projectWave: async (candidates: unknown[]) =>
          (
            await (source.projectWave
              ? source.projectWave(candidates)
              : Promise.all(candidates.map((candidate) => source.project(candidate))))
          ).map(keepUnknown),
        revalidate: async (item: PreparationSource) =>
          keepUnknown(source.revalidate ? await source.revalidate(item) : item),
      }));
      enter('discovery');
      const discovered = await budget.run(
        (signal) =>
          KnowledgeResolver.discover(discoveryQuery, {
            sources: eligible,
            limit: entry.maxCues,
            candidateBudget: Math.floor(20 / Math.max(1, sources.length)),
            waveSize: 2,
            signal,
            deadlineAt,
          }),
        200,
        input.signal,
      );
      enter('validate');
      const current = await budget.run(
        (signal) => this.deps.authority.validate(record, { signal, deadlineAt }),
        0,
        input.signal,
      );
      check();
      if (!current) {
        enter('finish');
        this.deps.store.finish(record.opportunityId, 'not_available');
        check();
        return empty('not_available');
      }
      enter('publish');
      const envelope = {
        status: 'ok',
        delivery: 'unknown' as const,
        opportunityId: record.opportunityId,
        observedAt: input.receivedAt,
        activity: input.activity,
        discoveryVersion: discovered.version,
        sources: discovered.sources.map(({ sourceId }) => ({ sourceId })),
      };
      const pointers = this.createPointers(
        opportunity,
        record,
        discovered.items,
        entry.maxPromptTokens,
        envelope,
        check,
      );
      enter('finish');
      this.deps.store.finish(record.opportunityId, 'resolved', discovered);
      check();
      return { ...envelope, pointers };
    } catch (error) {
      const status = input.signal.aborted ? 'cancelled' : 'source_unavailable';
      try {
        this.deps.logger?.warn(
          {
            ...preparationFailureFields(input.auth, received?.opportunityId, stage, started, stageStarted, error),
            sourcePhases: observations.snapshot(),
          },
          '[F332] work preparation stopped',
        );
      } catch {
        /* Optional diagnostics must not replace the original result. */
      }
      if (received) this.deps.store.finish(received.opportunityId, status);
      return empty(status);
    }
  }

  private createPointers(
    opportunity: Extract<RecallOpportunityV1, { kind: 'work_preparation' }>,
    record: WorkPreparationRecord,
    items: readonly PreparationSource[],
    maxTokens: number,
    envelope: Record<string, unknown>,
    check: () => void,
  ) {
    const pointers = [];
    for (const item of items) {
      check();
      let prepared: PreparedCoordinate | undefined;
      const cue = cueEnvelopeV1Schema.parse(
        buildCueEnvelope({
          opportunity,
          family: item.family,
          resolverVersion: item.resolverVersion ?? 1,
          whyNow: `Host received ${opportunity.payload.activity} preparation at ${new Date(opportunity.occurredAt).toISOString()}. Read the source and check its conditions before creating the work.`,
          source: item.source,
          context: {
            now: opportunity.occurredAt,
            expiresAt: record.expiresAt,
            consumerCatId: record.consumerCatId,
            createDrillHandle: (coordinate) => {
              prepared = {
                coordinate,
                ...(item.matterReadDetails ? { matterReadDetails: item.matterReadDetails } : {}),
              };
              return this.deps.handles.issue(coordinate);
            },
          },
        }),
      );
      if (!prepared || this.deps.store.wasConsumed(record, prepared.coordinate)) continue;
      const pointer = {
        cueId: cue.cueId,
        whyNow: cue.whyNow,
        association: { kind: 'indexed_query_match', queryDigest: record.queryDigest },
        source: cue.source,
        read: { tool: 'cat_cafe_drill_memory_cue', handle: cue.drill.handle },
        ...(item.family === 'matter' ? { application: 'not_supported' } : {}),
      };
      if (estimateTokens(JSON.stringify({ ...envelope, pointers: [...pointers, pointer] })) > maxTokens) break;
      check();
      this.deps.store.save(record.opportunityId, prepared);
      pointers.push(pointer);
    }
    check();
    return pointers;
  }

  private recordFor(scope: RecallScopeV1, catId: string | undefined, opportunityId: string | undefined) {
    const record = opportunityId ? this.deps.store.get(opportunityId) : null;
    return record &&
      record.scope.ownerUserId === scope.ownerUserId &&
      record.scope.threadId === scope.threadId &&
      record.scope.invocationId === scope.invocationId &&
      record.consumerCatId === catId
      ? record
      : null;
  }

  async read(request: Parameters<MemoryCueSourceReader['read']>[0]): ReturnType<MemoryCueSourceReader['read']> {
    const record = this.recordFor(request.scope, request.consumerCatId, request.opportunityId);
    const prepared = record
      ? this.deps.store.details(record.opportunityId, request.anchor, request.expectedRevision)
      : null;
    if (!record || !prepared || !(await this.deps.authority.validate(record)))
      return { status: 'not_available', invalidationReason: 'scope_revoked' };
    const result = await this.deps.sources.read(record, request, prepared);
    return (await this.deps.authority.validate(record))
      ? result
      : { status: 'not_available', invalidationReason: 'scope_revoked' };
  }

  recordInvalidation(
    coordinate: MemoryCueDrillCoordinate,
    reason: MemoryCueInvalidationReason,
    occurredAt: number,
  ): void {
    const prepared = this.deps.store.details(coordinate.opportunityId, coordinate.anchor, coordinate.revision);
    if (!prepared || prepared.coordinate.cueId !== coordinate.cueId) return;
    const key = `preparation-invalid-${createHash('sha256').update(`${coordinate.cueId}\0${reason}`).digest('hex')}`;
    if (this.deps.episodes.getByEventId(key)) return;
    this.deps.episodes.append({
      eventId: key,
      idempotencyKey: key,
      cueId: coordinate.cueId,
      opportunityId: coordinate.opportunityId,
      scope: coordinate.scope,
      consumerCatId: coordinate.consumerCatId,
      resolverFamily: coordinate.resolverFamily,
      resolverVersion: coordinate.resolverVersion,
      sourceAnchor: coordinate.anchor,
      sourceRevision: coordinate.revision,
      catalogVersion: coordinate.catalogVersion,
      axis: 'invalidation',
      invalidationReason: reason,
      occurredAt,
      readOrigin: 'explicit_read',
      ...(prepared.matterReadDetails ? { readDetails: prepared.matterReadDetails } : {}),
    });
  }

  recordRead(coordinate: MemoryCueDrillCoordinate, requestId: string, occurredAt: number): void {
    const record = this.recordFor(coordinate.scope, coordinate.consumerCatId, coordinate.opportunityId);
    const prepared = record
      ? this.deps.store.details(record.opportunityId, coordinate.anchor, coordinate.revision)
      : null;
    if (!prepared || prepared.coordinate.cueId !== coordinate.cueId)
      throw new Error('Preparation read is not admitted');
    this.deps.episodes.appendPreparationRead({
      coordinate,
      requestId,
      occurredAt,
      ...(prepared.matterReadDetails ? { details: prepared.matterReadDetails } : {}),
    });
  }
}
