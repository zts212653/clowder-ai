import { createHash } from 'node:crypto';
import type { TraceAnnotation } from '@cat-cafe/shared';
import type { InjectionTraceStore } from '../../../domains/prompt-hooks/InjectionTraceStore.js';
import type { PendingTraceMarkerStore } from './PendingTraceMarkerStore.js';
import type { TraceAnnotationStore } from './TraceAnnotationStore.js';
import { traceMetricIncidentKey } from './trace-incident-key.js';

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export async function resolvePendingTraceMarkers(deps: {
  invocationId: string;
  traceStore: InjectionTraceStore;
  markerStore: PendingTraceMarkerStore;
  annotationStore: TraceAnnotationStore;
  annotationSink?: {
    append(annotation: TraceAnnotation): Promise<{
      outcome: 'created' | 'duplicate';
      annotationId: string;
      unitEvaluationReady?: boolean;
    }>;
  };
}): Promise<{ resolved: number; waitingForTerminal: boolean; unitEvaluationReady: boolean }> {
  const episode = await deps.traceStore.getEpisodeByInvocationId(deps.invocationId);
  if (!episode) return { resolved: 0, waitingForTerminal: true, unitEvaluationReady: false };

  const markers = await deps.markerStore.listPending(deps.invocationId);
  let resolved = 0;
  let requiresSemanticSweep = false;
  let unitEvaluationReady = false;
  for (const marker of markers) {
    const polarity = marker.polarity;
    if (polarity === 'candidate') requiresSemanticSweep = true;
    const incidentKey = traceMetricIncidentKey({
      ownerUserId: marker.ownerUserId,
      invocationId: marker.invocationId,
      objectiveId: marker.objectiveId,
      metricId: marker.metricId,
      polarity,
    });
    const annotationId = `ann-${digest(['annotation', incidentKey])}`;
    const annotation: TraceAnnotation = {
      annotationId,
      episodeRef: episode.terminal,
      source: 'mcp-marker',
      ruleId: `mcp:${marker.objectiveId}:${marker.metricId}`,
      objectiveId: marker.objectiveId,
      metricId: marker.metricId,
      unitRefs: marker.unitRefs,
      polarity,
      confidence: marker.polarity === 'candidate' ? 0.6 : 1,
      incidentKey,
      evidenceRefs: [
        `trace://${episode.terminal.threadId}/${episode.terminal.traceTurnId}`,
        `invocation://${episode.terminal.invocationId}`,
      ],
      ...(marker.note ? { rationale: marker.note } : {}),
      createdAt: episode.terminal.terminalAt,
    };
    const result = await (deps.annotationSink ?? deps.annotationStore).append(annotation);
    unitEvaluationReady ||= 'unitEvaluationReady' in result && result.unitEvaluationReady === true;
    await deps.markerStore.markResolved(marker.markerId, result.annotationId);
    resolved++;
  }
  if (resolved > 0 && !requiresSemanticSweep) {
    await deps.traceStore.markEpisodeClassified(episode.terminal.ownerUserId, episode.terminal.invocationId);
  }
  return { resolved, waitingForTerminal: false, unitEvaluationReady };
}
