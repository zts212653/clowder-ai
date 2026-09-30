import type { ScheduleContribution } from '@clowder-ai/plugin-contract';
import type { TaskSpec_P1 } from '../../../infrastructure/scheduler/types.js';
import type { PluginRuntimeAdmission } from '../carrier/runtime-carrier.js';

type InvokePluginAction = (pluginInstanceId: string, method: string, params: unknown) => Promise<unknown>;

/** The scheduler task a declared `schedule` contribution runs: it invokes the declared action. */
export function scheduleTask(
  admission: PluginRuntimeAdmission,
  contribution: ScheduleContribution,
  invoke: InvokePluginAction,
): TaskSpec_P1 {
  const taskId = `plugin:${admission.packageRecord.pluginId}:schedule:${contribution.id}`;
  const params = contribution.action.params ?? {};
  return {
    id: taskId,
    profile: 'poller',
    trigger:
      contribution.schedule.kind === 'interval'
        ? { type: 'interval', ms: contribution.schedule.everyMs }
        : { type: 'cron', expression: contribution.schedule.expression },
    admission: {
      gate: async () => ({
        run: true,
        workItems: [{ signal: structuredClone(params), subjectKey: contribution.id }],
      }),
    },
    run: {
      overlap: contribution.policy.overlap,
      timeoutMs: contribution.policy.timeoutMs,
      execute: async (signal) => {
        await invoke(admission.instance.pluginInstanceId, contribution.action.method, signal);
      },
    },
    state: { runLedger: 'sqlite' },
    outcome: { whenNoSignal: 'drop' },
    enabled: () => true,
  };
}
