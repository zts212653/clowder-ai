import { CLI_PROCESS_SNAPSHOT_TIMEOUT_MS } from '../../dist/utils/cli-process-ownership.js';

// Shutdown can synchronously scan ownership before TERM, on child exit, while
// polling the tree, and around KILL escalation. A single production scan may
// legally consume its full timeout under suite load, so the test deadline must
// cover the bounded chain instead of racing the first scan.
export const SUPERVISOR_EXIT_TIMEOUT_MS = CLI_PROCESS_SNAPSHOT_TIMEOUT_MS * 6 + 3_000;

export function waitForSupervisorExit(supervisor) {
  if (supervisor.exitCode !== null || supervisor.signalCode !== null) {
    return Promise.resolve({ code: supervisor.exitCode, signal: supervisor.signalCode });
  }
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ timedOut: true }), SUPERVISOR_EXIT_TIMEOUT_MS);
    supervisor.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}
