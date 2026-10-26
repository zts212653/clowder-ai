import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { createDirectAgentCarrierSession } from '../domains/cats/services/agents/providers/DirectAgentCarrierSession.js';
import type { AgentCarrierSession } from '../domains/cats/services/types.js';
import { readonlyCodexExecutable, readonlyCommandPlan, readonlyEnvironment } from './managed-readonly-plan.js';
import type { SpawnAdmission, WakeWhenResult } from './managed-runner.js';

type Envelope = Record<string, unknown>;
function record(value: unknown): Envelope | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Envelope) : undefined;
}

export function readonlyFailure(error: unknown, started: number, timedOut = false): WakeWhenResult {
  const message = error instanceof Error ? error.message : String(error);
  return { exitCode: null, timedOut, durationMs: Date.now() - started, tailOutput: message.slice(-8192) };
}

/** One connection-owned native process, returned through the existing managed runner lifecycle. */
export async function runManagedReadonlyCommand(
  command: string,
  cwd: string,
  timeoutMs: number,
  signal: AbortSignal,
  onAdmission?: (admission: SpawnAdmission) => void,
): Promise<WakeWhenResult> {
  const started = Date.now();
  let home: string | undefined;
  let wire: AgentCarrierSession | undefined;
  let settledAdmission = false;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let closeDeadline: ReturnType<typeof setTimeout> | undefined;
  let executionDeadline: ReturnType<typeof setTimeout> | undefined;
  let executionExpiresAt: number | undefined;
  let timedOut = false;
  let result: WakeWhenResult;
  const admit = (admission: SpawnAdmission) => {
    if (settledAdmission) return;
    settledAdmission = true;
    onAdmission?.(admission);
  };
  let nextId = 0;
  const pending = new Map<number, { resolve(value: Envelope): void; reject(error: Error): void }>();
  const failPending = (error: Error) => {
    for (const entry of pending.values()) entry.reject(error);
    pending.clear();
  };
  const request = (method: string, params: Envelope): Promise<Envelope> => {
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      void Promise.resolve()
        .then(() => {
          if (!wire) throw new Error('readonly_transport_unavailable');
          return wire.write({ id, method, params });
        })
        .catch((error: Error) => {
          pending.delete(id);
          reject(error);
        });
    });
  };
  const processId = `managed-readonly-${randomUUID()}`;
  let executing = false;
  const terminateCarrier = () => {
    const current = wire;
    if (current?.terminate)
      void Promise.resolve()
        .then(() => current.terminate?.())
        .catch(failPending);
  };
  const cancel = () => {
    if (!executing) {
      failPending(new Error('readonly_cancelled_before_execution'));
      terminateCarrier();
      return;
    }
    // Native terminate is scoped to this connection/processId. Never signal a caller-supplied PID.
    void request('command/exec/terminate', { processId }).catch(() => {});
    if (closeDeadline) return;
    closeDeadline = setTimeout(() => {
      failPending(new Error('readonly_cancel_terminal_timeout'));
      terminateCarrier();
    }, 2000);
  };
  try {
    signal.throwIfAborted();
    home = await mkdtemp(join(tmpdir(), 'cat-cafe-readonly-host-'));
    signal.throwIfAborted();
    const plan = readonlyCommandPlan(command, cwd, home, timeoutMs, processId);
    const environment = readonlyEnvironment(home, home);
    const executable = await readonlyCodexExecutable(environment);
    signal.throwIfAborted();
    wire = await createDirectAgentCarrierSession(
      {
        command: executable,
        args: ['app-server', '--config', 'mcp_servers={}', '--config', 'apps._default.enabled=false'],
        cwd: home,
        invocationId: processId,
      },
      { finalEnvironment: environment },
    );
    const activeWire = wire;
    const reading = (async () => {
      for await (const value of activeWire.read()) {
        const envelope = record(value);
        if (typeof envelope?.id !== 'number') continue;
        const entry = pending.get(envelope.id);
        if (!entry) continue;
        pending.delete(envelope.id);
        if (envelope.error) entry.reject(new Error(`readonly_native_rpc:${JSON.stringify(envelope.error)}`));
        else entry.resolve(record(envelope.result) ?? {});
      }
      failPending(new Error('readonly_transport_closed'));
    })();
    void reading.catch((error: Error) => failPending(error));
    deadline = setTimeout(() => {
      failPending(new Error('readonly_transport_timeout'));
      terminateCarrier();
    }, timeoutMs + 10_000);
    signal.addEventListener('abort', cancel, { once: true });
    if (signal.aborted) cancel();
    await request('initialize', {
      clientInfo: { name: 'cat-cafe-managed-readonly', version: '1' },
      capabilities: { experimentalApi: true },
    });
    await wire.write({ method: 'initialized' });
    signal.throwIfAborted();
    // Report actual native carrier admission, after capability preparation and initialization.
    executing = true;
    // Host owns timeout truth. Native also bounds execution, but exit 124 alone is ambiguous.
    executionExpiresAt = performance.now() + timeoutMs;
    executionDeadline = setTimeout(() => {
      timedOut = true;
      cancel();
    }, timeoutMs);
    const completion = request('command/exec', { ...plan });
    admit({ spawned: true, pid: wire.pid ?? null });
    const nativeResult = await completion;
    timedOut ||= performance.now() >= executionExpiresAt;
    if (
      typeof nativeResult.exitCode !== 'number' ||
      typeof nativeResult.stdout !== 'string' ||
      typeof nativeResult.stderr !== 'string'
    )
      throw new Error('readonly_native_result_invalid');
    result = {
      exitCode: signal.aborted || timedOut ? null : nativeResult.exitCode,
      timedOut,
      durationMs: Date.now() - started,
      tailOutput: `${nativeResult.stdout}${nativeResult.stderr}`.split('\n').slice(-50).join('\n'),
    };
  } catch (error) {
    timedOut ||= executionExpiresAt !== undefined && performance.now() >= executionExpiresAt;
    result = readonlyFailure(error, started, timedOut);
    admit({ spawned: false, pid: null, error: result.tailOutput, failureKind: 'admission_rejected' });
  } finally {
    if (deadline) clearTimeout(deadline);
    if (closeDeadline) clearTimeout(closeDeadline);
    if (executionDeadline) clearTimeout(executionDeadline);
    signal.removeEventListener('abort', cancel);
    failPending(new Error('readonly_transport_closed'));
    // Cleanup errors cannot replace completion with an unobserved rejected promise.
    for (const cleanup of [
      () => wire?.close(),
      () => (home ? rm(home, { recursive: true, force: true }) : undefined),
    ]) {
      try {
        await cleanup();
      } catch (error) {
        result = readonlyFailure(error, started, timedOut);
      }
    }
  }
  return result;
}
