import type { TraceAnnotation } from '@cat-cafe/shared';
import type { RedisClient } from '@cat-cafe/shared/utils';
import { InjectionTraceStore } from '../../../domains/prompt-hooks/InjectionTraceStore.js';
import type { TraceAnnotationStore } from '../trace-annotation/TraceAnnotationStore.js';
import { CycleRecordStore } from './CycleRecordStore.js';
import { CycleTriggerChecker, type CycleVersionRef } from './CycleTriggerChecker.js';
import { EvaluationIndexer } from './EvaluationIndexer.js';
import { type EvaluationCatalog } from './evaluation-catalog.js';
import { type ObjectiveVersionState, segmentVersionFromContentRef } from './ObjectiveVersionStore.js';

export class ObjectiveEvaluationRuntime {
  readonly indexer: EvaluationIndexer;
  readonly cycles: CycleRecordStore;
  readonly cycleChecker: CycleTriggerChecker;
  readonly traces: InjectionTraceStore;
  private readonly resolveVersionFn: (
    objectiveId: string,
    state: ObjectiveVersionState,
  ) => CycleVersionRef | Promise<CycleVersionRef>;

  constructor(
    private readonly redis: RedisClient,
    readonly catalog: EvaluationCatalog,
    readonly annotations: TraceAnnotationStore,
    options: {
      traceStore?: InjectionTraceStore;
      resolveVersion?: (
        objectiveId: string,
        state: ObjectiveVersionState,
      ) => CycleVersionRef | Promise<CycleVersionRef>;
    } = {},
  ) {
    this.indexer = new EvaluationIndexer(catalog, annotations);
    this.traces = options.traceStore ?? new InjectionTraceStore(redis);
    this.cycles = new CycleRecordStore(redis);
    this.resolveVersionFn =
      options.resolveVersion ??
      ((objectiveId) => {
        const objective = catalog.registry.objectives.find((item) => item.id === objectiveId);
        const model = catalog.registry.evaluationModels.find((item) => item.id === objective?.evaluationModelId);
        if (!model) throw new Error(`cycle_evaluation_model_not_found:${objectiveId}`);
        return {
          version: model.ruleVersion,
          versionContentRef: `evaluation-model:${model.id}@${model.ruleVersion}`,
        };
      });
    this.cycleChecker = new CycleTriggerChecker({
      catalog,
      cycles: this.cycles,
      traces: this.traces,
      annotations,
      resolveVersion: this.resolveVersionFn,
    });
  }

  resolveVersion(objectiveId: string, state: ObjectiveVersionState): Promise<CycleVersionRef> {
    return Promise.resolve(this.resolveVersionFn(objectiveId, state));
  }

  resolveSegmentVersion(versionContentRef: string, segmentId: string): Promise<number | null> {
    return segmentVersionFromContentRef(this.redis, versionContentRef, segmentId);
  }

  async append(annotation: TraceAnnotation): Promise<{
    outcome: 'created' | 'duplicate';
    annotationId: string;
    cycleEvaluationReady?: boolean;
  }> {
    const appended = await this.indexer.append(annotation);
    const checked = await this.cycleChecker.checkObjective(
      annotation.episodeRef.ownerUserId,
      annotation.objectiveId,
      annotation.createdAt + 1,
    );
    return { ...appended, ...(checked.status === 'requested' ? { cycleEvaluationReady: true } : {}) };
  }

  async initializeCycles(ownerUserId: string, now: number): Promise<void> {
    await this.cycleChecker.initializeOwner(ownerUserId, now);
  }

  async runCadenceMetrics(ownerUserId: string, now: number): Promise<number> {
    return this.cycleChecker.checkOwner(ownerUserId, now);
  }

  async checkCyclesAfterTrace(ownerUserId: string, invocationId: string, now: number): Promise<number> {
    return this.cycleChecker.checkTrace(ownerUserId, invocationId, now);
  }

  async checkKnownCycleOwners(now: number): Promise<number> {
    return this.cycleChecker.checkKnownOwners(now);
  }
}
