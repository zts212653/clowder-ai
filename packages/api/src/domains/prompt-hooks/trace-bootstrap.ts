/**
 * TraceBootstrap — F237 (Trace v0)
 *
 * Module-level singleton for InjectionTraceStore.
 * Bootstrapped once at server startup when Redis is available.
 */

import type { RedisClient } from '@cat-cafe/shared/utils';
import type { EvaluationCatalog } from '../../infrastructure/harness-eval/evaluation/evaluation-catalog.js';
import { ObjectiveEvaluationRuntime } from '../../infrastructure/harness-eval/evaluation/ObjectiveEvaluationRuntime.js';
import { ObjectiveVersionStore } from '../../infrastructure/harness-eval/evaluation/ObjectiveVersionStore.js';
import { PendingTraceMarkerStore } from '../../infrastructure/harness-eval/trace-annotation/PendingTraceMarkerStore.js';
import { resolvePendingTraceMarkers } from '../../infrastructure/harness-eval/trace-annotation/resolve-pending-markers.js';
import { deriveStructuredTraceAnnotations } from '../../infrastructure/harness-eval/trace-annotation/structured-rule-tagger.js';
import { TraceAnnotationStore } from '../../infrastructure/harness-eval/trace-annotation/TraceAnnotationStore.js';
import type { StoredToolEvent } from '../cats/services/stores/ports/MessageStore.js';
import { InjectionTraceStore } from './InjectionTraceStore.js';
import { getCachedRegistry } from './PipelinePromptBuilder.js';
import { closeTraceEpisode } from './trace-episode-terminal.js';

let _traceStore: InjectionTraceStore | null = null;
let _markerStore: PendingTraceMarkerStore | null = null;
let _annotationStore: TraceAnnotationStore | null = null;
let _evaluationRuntime: ObjectiveEvaluationRuntime | null = null;

/** Bootstrap the trace store singleton. Call once at server startup. */
export function bootstrapTraceStore(redis: RedisClient): void {
  _traceStore = new InjectionTraceStore(redis);
  _markerStore = new PendingTraceMarkerStore(redis);
  _annotationStore = new TraceAnnotationStore(redis);
}

export function bootstrapObjectiveEvaluationRuntime(redis: RedisClient, catalog: EvaluationCatalog): void {
  if (!_annotationStore || !_traceStore) throw new Error('trace_store_must_be_bootstrapped_first');
  const versions = new ObjectiveVersionStore(redis, catalog, getCachedRegistry);
  _evaluationRuntime = new ObjectiveEvaluationRuntime(redis, catalog, _annotationStore, {
    traceStore: _traceStore,
    resolveVersion: (objectiveId, state) => versions.resolve(objectiveId, state),
  });
}

/** Get the bootstrapped trace store (null if Redis unavailable). */
export function getTraceStore(): InjectionTraceStore | null {
  return _traceStore;
}

export function getTraceEvaluationStores(): {
  traceStore: InjectionTraceStore;
  markerStore: PendingTraceMarkerStore;
  annotationStore: TraceAnnotationStore;
  annotationSink?: ObjectiveEvaluationRuntime;
} | null {
  if (!_traceStore || !_markerStore || !_annotationStore) return null;
  return {
    traceStore: _traceStore,
    markerStore: _markerStore,
    annotationStore: _annotationStore,
    ...(_evaluationRuntime ? { annotationSink: _evaluationRuntime } : {}),
  };
}

export function getObjectiveEvaluationRuntime(): ObjectiveEvaluationRuntime | null {
  return _evaluationRuntime;
}

export async function resolvePendingMarkersForInvocation(invocationId: string): Promise<boolean> {
  const stores = getTraceEvaluationStores();
  if (!stores) return false;
  const result = await resolvePendingTraceMarkers({ invocationId, ...stores });
  return result.unitEvaluationReady;
}

export async function annotateStructuredRulesForInvocation(invocationId: string): Promise<boolean> {
  const stores = getTraceEvaluationStores();
  if (!stores) return false;
  const episode = await stores.traceStore.getEpisodeByInvocationId(invocationId);
  if (!episode) return false;
  const annotations = deriveStructuredTraceAnnotations(episode);
  let unitEvaluationReady = false;
  for (const annotation of annotations) {
    const result = await (stores.annotationSink ?? stores.annotationStore).append(annotation);
    unitEvaluationReady ||= 'unitEvaluationReady' in result && result.unitEvaluationReady === true;
  }
  if (annotations.length > 0) {
    await stores.traceStore.markEpisodeClassified(episode.terminal.ownerUserId, invocationId);
  }
  return unitEvaluationReady;
}

/**
 * Close one trace only after its summary and terminal output are durable, then run
 * deterministic annotations, then check every Objective cycle directly.
 */
export async function finalizeTraceEpisode(params: {
  traceTurnId: string;
  invocationId: string;
  ownerUserId: string;
  threadId: string;
  catId: string;
  inputMessageId: string | null;
  outputMessageId: string | null;
  terminalKind: 'completed' | 'failed' | 'cancelled';
  toolEvents: readonly StoredToolEvent[];
  terminalAt?: number;
}): Promise<void> {
  if (!_traceStore) return;
  await closeTraceEpisode({ traceStore: _traceStore, ...params });
  await resolvePendingMarkersForInvocation(params.invocationId);
  await annotateStructuredRulesForInvocation(params.invocationId);
  await _evaluationRuntime?.checkCyclesAfterTrace(
    params.ownerUserId,
    params.invocationId,
    (params.terminalAt ?? Date.now()) + 1,
  );
}
