import type { TaskProfile } from './types.js';

interface ProfileDefaults {
  trigger: { ms: number };
  run: { timeoutMs: number };
  outcome: { whenNoSignal: 'drop' | 'record' };
}

export const PROFILE_DEFAULTS: Record<TaskProfile, ProfileDefaults> = {
  awareness: {
    trigger: { ms: 30 * 60 * 1000 },
    run: { timeoutMs: 120_000 },
    outcome: { whenNoSignal: 'drop' },
  },
  poller: {
    trigger: { ms: 60_000 },
    run: { timeoutMs: 30_000 },
    outcome: { whenNoSignal: 'record' },
  },
};
