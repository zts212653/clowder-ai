import { createHash } from 'node:crypto';
import type { TraceAnnotation, TraceEpisode } from '@cat-cafe/shared';
import { traceMetricIncidentKey } from './trace-incident-key.js';

const TOOL_SCHEMA_ERROR =
  /(?:invalid\s+(?:arguments?|params?|input)|schema\s+(?:error|validation)|validation\s+(?:error|failed)|required\s+(?:property|field)|missing\s+required|unknown\s+tool|tool\s+not\s+found|unrecognized\s+(?:key|field|property))/i;

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export function deriveStructuredTraceAnnotations(episode: TraceEpisode): TraceAnnotation[] {
  const schemaFailure = episode.terminal.toolCalls.find(
    (toolCall) =>
      toolCall.outcome === 'error' &&
      typeof toolCall.resultDetail === 'string' &&
      TOOL_SCHEMA_ERROR.test(toolCall.resultDetail),
  );
  if (!schemaFailure) return [];

  const coordinate = {
    ownerUserId: episode.terminal.ownerUserId,
    invocationId: episode.terminal.invocationId,
    objectiveId: 'tool-access-correct-use',
    metricId: 'tool-schema-failure-count',
    polarity: 'counterexample' as const,
  };
  const incidentKey = traceMetricIncidentKey(coordinate);
  return [
    {
      annotationId: `ann-${digest(['structured-rule', incidentKey])}`,
      episodeRef: episode.terminal,
      source: 'structured-rule',
      ruleId: 'tool-schema-failure-v1',
      objectiveId: coordinate.objectiveId,
      metricId: coordinate.metricId,
      unitRefs: [{ unitType: 'segment', unitId: 'S13' }],
      polarity: coordinate.polarity,
      confidence: 1,
      incidentKey,
      evidenceRefs: [
        `trace://${episode.terminal.threadId}/${episode.terminal.traceTurnId}`,
        `invocation://${episode.terminal.invocationId}`,
        `tool-call://${schemaFailure.callId ?? schemaFailure.toolName}`,
      ],
      rationale: `Tool ${schemaFailure.toolName} returned an explicit name/schema validation error.`,
      createdAt: episode.terminal.terminalAt,
    },
  ];
}
