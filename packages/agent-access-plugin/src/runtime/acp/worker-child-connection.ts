/**
 * ACP stdio child across the F202 execution-worker boundary.
 *
 * The Host owns process authorization: it spawns, secures the launch context and
 * keeps lifecycle/audit. The plugin receives only this connection: byte pipes,
 * liveness, exit facts and shutdown. The plugin never builds an `AcpChildConnection`
 * from raw `child_process` handles; it asks the Host's retained launch callable over
 * the existing execution RPC and attaches to the streams and callables it answers with.
 *
 * Everything here rides on the existing remote-value encoding:
 *   - stdout/stderr → transferred `Readable`s (native streams, backpressure preserved)
 *   - write/shutdown → remote callables (async; one RPC round trip per call)
 *   - termination   → one pending call resolved by the first error or exit
 *   - pid           → a data field read once at attach time
 *
 * No Host internals leak into the plugin: this module types against
 * `AcpChildConnection` and nothing else, so Host ACP interpretation state stays on
 * the Host side.
 *
 * Host-side requirement this module depends on: the execution RPC picks the encode
 * scope of every reply by `isMainThread && pending(rootId) ? rootId : 'retained'`, and
 * `RemoteValues.end('retained')` is a no-op once the scope exists. So a launch reply's
 * callables survive that reply and every later one — they are dropped only when the
 * peer closes, i.e. when the activation ends. The plugin can tell that apart from a
 * live child: a call after the Host lease ended rejects, and a rejected write is a
 * terminal pipe failure here, never a silent drop. The Host therefore hands out a
 * child handle per launch and keeps it tied to its own child lifecycle; it does not
 * need to re-issue the launch capability per turn.
 */
import type { AgentAccessAcpChildHandle } from '@clowder-ai/agent-contract/acp';
import type { AcpChildConnection } from './AcpClient.js';

export type WorkerAcpChildHandle = AgentAccessAcpChildHandle;

/**
 * Attach to the Host-launched ACP child as the plugin's `AcpChildConnection`.
 *
 * `write` is the one place a Host write becomes a sync-looking pipe: Node's
 * `Writable.write` cannot await, so the plugin keeps writing immediately and holds
 * the first async failure. After that `isWritable()` reports false and the next
 * `write` throws the real error instead of silently dropping bytes.
 */
export async function attachWorkerChildConnection(
  launch: () => Promise<WorkerAcpChildHandle>,
): Promise<AcpChildConnection> {
  const handle = await launch();

  let closed = false;
  let writable = await handle.isWritable();
  let killed = await handle.isKilled();
  let failure: Error | undefined;

  const errorListeners = new Set<(error: Error) => void>();
  const exitListeners = new Set<(code: number | null, signal: NodeJS.Signals | null) => void>();

  let exit: [number | null, NodeJS.Signals | null] | undefined;
  const fail = (error: unknown): void => {
    const reason = error instanceof Error ? error : new Error(String(error));
    if (failure) return;
    failure = reason;
    writable = false;
    // A failed pipe is a terminal connection fact, not a per-line rejection.
    for (const listener of errorListeners) listener(reason);
  };
  void handle.termination().then((outcome) => {
    closed = true;
    writable = false;
    if (outcome.kind === 'error') {
      fail(outcome.error);
      return;
    }
    killed = true;
    exit = [outcome.code, outcome.signal];
    for (const listener of exitListeners) listener(...exit);
  }, fail);

  return {
    pid: handle.pid,
    stdout: handle.stdout,
    stderr: handle.stderr,
    isWritable: () => !closed && !failure && writable,
    isKilled: () => killed || failure !== undefined,
    write: (line) => {
      if (failure) throw failure;
      // The callable is async; keep the pipeline's synchronous write contract and
      // remember the first rejection as a terminal pipe failure.
      Promise.resolve(handle.write(line)).catch(fail);
    },
    onError: (listener) => {
      errorListeners.add(listener);
      if (failure) listener(failure);
    },
    onExit: (listener) => {
      exitListeners.add(listener);
      if (exit) listener(...exit);
    },
    shutdown: (graceMs, endStdin) => handle.shutdown(graceMs, endStdin),
  };
}
