import type { LivenessWarningEvent } from '../../../../../../../utils/ProcessLivenessProbe.js';
import type { AgentMessage, MessageMetadata } from '../../../../types.js';
import { type AgyNativeLaunchInput, type AgyNativeLaunchPlan, prepareAgyNativeLaunch } from '../agy-native-launch.js';

/** Surface real discovery warnings while preserving ownership when the consumer closes early. */
export async function* prepareAgyNativeLaunchWithProgress(
  input: AgyNativeLaunchInput,
  metadata: MessageMetadata,
): AsyncGenerator<AgentMessage, AgyNativeLaunchPlan> {
  const cancelled = new AbortController();
  const signal = input.options?.signal ? AbortSignal.any([input.options.signal, cancelled.signal]) : cancelled.signal;
  const warnings: LivenessWarningEvent[] = [];
  let notify = () => {};
  const state: { outcome?: { plan: AgyNativeLaunchPlan } | { error: unknown } } = {};
  const settled = prepareAgyNativeLaunch({
    ...input,
    options: { ...input.options, signal },
    onVersionWarning: (warning) => {
      warnings.push(warning);
      notify();
    },
  }).then(
    (plan) => ({ plan }),
    (error: unknown) => ({ error }),
  );
  void settled.then((outcome) => {
    state.outcome = outcome;
    notify();
  });
  let handedOff = false;
  try {
    for (;;) {
      await new Promise<void>((resolve) => {
        notify = resolve;
        if (state.outcome || warnings.length) resolve();
      });
      for (const warning of warnings.splice(0))
        yield {
          type: 'system_info',
          catId: input.catId,
          content: JSON.stringify({ type: 'liveness_warning', ...warning, phase: 'capacity_version_discovery' }),
          metadata,
          timestamp: Date.now(),
        };
      if (state.outcome) {
        if ('error' in state.outcome) throw state.outcome.error;
        handedOff = true;
        return state.outcome.plan;
      }
    }
  } finally {
    if (!handedOff) {
      cancelled.abort();
      const outcome = await settled;
      if ('plan' in outcome) await outcome.plan.disposeCredentials?.();
    }
  }
}
