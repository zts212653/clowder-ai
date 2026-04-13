/**
 * F152: First batch of OTel instruments for Cat Cafe observability.
 *
 * All instruments use the `cat_cafe.` prefix and are bound by the
 * MetricAttributeAllowlist Views (D2 enforcement).
 */

import { metrics } from '@opentelemetry/api';

const meter = metrics.getMeter('cat-cafe-api', '0.1.0');

/** Histogram: invocation duration (seconds). */
export const invocationDuration = meter.createHistogram('cat_cafe.invocation.duration', {
  description: 'Duration of a single cat invocation',
  unit: 's',
});

/** Histogram: individual LLM API call duration (seconds). */
export const llmCallDuration = meter.createHistogram('cat_cafe.llm.call.duration', {
  description: 'Duration of a single LLM API call',
  unit: 's',
});

/**
 * Gauge: agent liveness state.
 * 0=dead, 1=idle-silent, 2=busy-silent, 3=active.
 */
export const agentLiveness = meter.createObservableGauge('cat_cafe.agent.liveness', {
  description: 'Agent process liveness state (0=dead, 1=idle-silent, 2=busy-silent, 3=active)',
});

/** UpDownCounter: currently active invocations. */
export const activeInvocations = meter.createUpDownCounter('cat_cafe.invocation.active', {
  description: 'Number of currently active invocations',
});

/** Counter: token usage (split by input/output via attributes). */
export const tokenUsage = meter.createCounter('cat_cafe.token.usage', {
  description: 'Cumulative token consumption',
  unit: 'tokens',
});

/** Counter: guide lifecycle transitions (A-4). */
export const guideTransitions = meter.createCounter('cat_cafe.guide.transitions', {
  description: 'Guide lifecycle state transitions',
});

/** Liveness state type. */
export type LivenessState = 'dead' | 'idle-silent' | 'busy-silent' | 'active';

/** Map liveness state string to numeric gauge value. */
export function livenessStateToNumber(state: LivenessState): number {
  switch (state) {
    case 'dead':
      return 0;
    case 'idle-silent':
      return 1;
    case 'busy-silent':
      return 2;
    case 'active':
      return 3;
  }
}

// --- Liveness probe registry for ObservableGauge ---

interface LivenessProbeRef {
  catId: string;
  getState: () => LivenessState;
}

const activeProbes = new Map<string, LivenessProbeRef>();

/** Register a liveness probe for ObservableGauge polling. */
export function registerLivenessProbe(invocationId: string, catId: string, getState: () => LivenessState): void {
  activeProbes.set(invocationId, { catId, getState });
}

/** Unregister a liveness probe when invocation ends. */
export function unregisterLivenessProbe(invocationId: string): void {
  activeProbes.delete(invocationId);
}

// Register the ObservableGauge callback — polls all active probes
agentLiveness.addCallback((result) => {
  for (const [, probe] of activeProbes) {
    result.observe(livenessStateToNumber(probe.getState()), {
      'agent.id': probe.catId,
    });
  }
});
