import { createHash } from 'node:crypto';

export function traceMetricIncidentKey(input: {
  ownerUserId: string;
  invocationId: string;
  objectiveId: string;
  metricId: string;
  polarity: 'counterexample' | 'positive' | 'candidate' | 'irrelevant' | 'unscorable';
}): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        'trace-metric-incident',
        input.ownerUserId,
        input.invocationId,
        input.objectiveId,
        input.metricId,
        input.polarity,
      ]),
    )
    .digest('hex');
}
