import type { TaskProfile, TaskSpec_P1, TriggerSpec } from '../scheduler/types.js';

export const AUTOMATIC_EVAL_RETIRED_REASON = '自动评估与追结案已退役；保留现有任务、历史证据和迁接期间的按需接口。';

/** Keep the old scheduler identities visible without admitting or replaying work. */
export function createRetiredAutomaticEvalSpec<Signal>(input: {
  id: string;
  profile: TaskProfile;
  trigger: TriggerSpec;
  label: string;
}): TaskSpec_P1<Signal> {
  return {
    id: input.id,
    profile: input.profile,
    trigger: input.trigger,
    enabled: () => false,
    admission: {
      async gate() {
        return { run: false, reason: AUTOMATIC_EVAL_RETIRED_REASON };
      },
    },
    // A forced execution or an old admitted signal must also remain inert after restart.
    run: { overlap: 'skip', timeoutMs: 60_000, async execute() {} },
    state: { runLedger: 'sqlite' },
    outcome: { whenNoSignal: 'drop' },
    display: {
      label: input.label,
      category: 'system',
      description: AUTOMATIC_EVAL_RETIRED_REASON,
      subjectKind: 'none',
    },
  };
}
