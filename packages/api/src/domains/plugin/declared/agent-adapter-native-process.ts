import type { AgentAdapterNativeRuntime } from '@clowder-ai/agent-contract';
import { isCliError, isCliTimeout, isLivenessWarning, spawnCli } from '../../../utils/cli-spawn.js';
import type { CliSpawnOptions } from '../../../utils/cli-types.js';

type NativeRun = NonNullable<AgentAdapterNativeRuntime['run']>;
type ApprovedLaunch = Omit<CliSpawnOptions, 'signal' | 'inheritParentEnv' | 'outputMode'>;

/** The caller derives executable, cwd, argv and the account environment from a Host-approved grant. */
export function createAgentAdapterNativeProcess(
  approveLaunch: (input: Parameters<NativeRun>[0]) => ApprovedLaunch | Promise<ApprovedLaunch>,
): NativeRun {
  return async (input, signal) => {
    signal.throwIfAborted();
    const launch = await approveLaunch(input);
    signal.throwIfAborted();
    return (async function* () {
      signal.throwIfAborted();
      for await (const value of spawnCli({ ...launch, signal, inheritParentEnv: false, outputMode: 'ndjson' })) {
        const exitCode = isCliError(value) ? value.exitCode || null : isCliTimeout(value) ? null : undefined;
        if (exitCode !== undefined) {
          yield { kind: 'exit' as const, code: exitCode };
          return;
        }
        if (!isLivenessWarning(value)) yield { kind: 'record' as const, value };
      }
      yield { kind: 'exit' as const, code: signal.aborted ? null : 0 };
    })();
  };
}
