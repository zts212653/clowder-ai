export type AgentHookPhase =
  | 'hook-files-write'
  | 'claude-settings-merge'
  | 'capability-owner-check'
  | 'capability-sync'
  | 'health-check'
  | 'hook-files-health'
  | 'claude-settings-health'
  | 'skills-health'
  | 'mcp-health'
  | 'codex-output-validate';

export interface AgentHookDiagnostic {
  phase: AgentHookPhase;
  state: 'started' | 'completed' | 'failed';
  durationMs: number;
  userCpuMs: number;
  systemCpuMs: number;
}

export type AgentHookDiagnostics = (event: AgentHookDiagnostic) => void;

/** Diagnostics are opt-in, contain no work result/error, and cannot affect sync. */
export function measureHookPhase<T>(
  diagnostics: AgentHookDiagnostics | undefined,
  phase: AgentHookPhase,
  work: () => T,
): T {
  if (!diagnostics) return work();
  const started = performance.now();
  const cpu = process.cpuUsage();
  const emit = (state: AgentHookDiagnostic['state']) => {
    const used = process.cpuUsage(cpu);
    try {
      diagnostics({
        phase,
        state,
        durationMs: Math.round((performance.now() - started) * 100) / 100,
        userCpuMs: used.user / 1000,
        systemCpuMs: used.system / 1000,
      });
    } catch {
      // Observability never changes owner admission or configuration writes.
    }
  };
  emit('started');
  try {
    const result = work();
    if (result instanceof Promise) {
      return result.then(
        (value) => {
          emit('completed');
          return value;
        },
        (error: unknown) => {
          emit('failed');
          throw error;
        },
      ) as T;
    }
    emit('completed');
    return result;
  } catch (error) {
    emit('failed');
    throw error;
  }
}
