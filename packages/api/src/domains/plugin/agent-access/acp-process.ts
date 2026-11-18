import { randomUUID } from 'node:crypto';
import { PassThrough, Readable } from 'node:stream';
import { AGENT_ACCESS_PLUGIN_ID } from '@clowder-ai/agent-contract';
import type { AgentAccessAcpProcessTermination } from '@clowder-ai/agent-contract/acp';
import { z } from 'zod';
import {
  ACP_CHILD_SHUTDOWN_GRACE_MS,
  type AcpChildConnection,
} from '../../cats/services/agents/providers/acp/AcpClient.js';
import type { PluginRuntimeCarrierRouter } from '../carrier/runtime-carrier.js';
import type { PluginInventoryStore } from '../host-inventory/ports.js';

const commandSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('write'), line: z.string() }),
  z.object({
    kind: z.literal('shutdown'),
    graceMs: z.number().int().min(0).max(ACP_CHILD_SHUTDOWN_GRACE_MS),
    endStdin: z.boolean(),
  }),
]);
const openResultSchema = z.object({ commands: z.instanceof(Readable) });

export function createAgentAccessAcpProcess(
  inventory: Pick<PluginInventoryStore, 'readCurrentAuthority'>,
  runtime: Pick<PluginRuntimeCarrierRouter, 'invoke' | 'nativeActions'>,
) {
  return async (
    cwd: string,
    launch: () => {
      child: AcpChildConnection;
      stdout: Readable;
      stderr?: Readable;
      writeApprovedLine: (line: string) => Promise<void>;
    },
  ) => {
    const selected = (await inventory.readCurrentAuthority(AGENT_ACCESS_PLUGIN_ID))?.instance;
    if (!selected || selected.activationState !== 'enabled' || selected.runtimeState !== 'healthy')
      throw new Error('session_implementation_unavailable');

    const pluginInstanceId = selected.pluginInstanceId;
    const signal = runtime.nativeActions.activationSignal(pluginInstanceId);
    signal.throwIfAborted();
    const { child, stdout, stderr, writeApprovedLine } = launch();
    const processId = randomUUID();
    const lifecycle = new PassThrough({ objectMode: true });
    let shutdown: Promise<void> | undefined;
    let pump: Promise<void> | undefined;
    let commands: Readable | undefined;
    const stop = (graceMs = ACP_CHILD_SHUTDOWN_GRACE_MS, endStdin = false) =>
      (shutdown ??= child.shutdown(graceMs, endStdin));
    const retire = () => {
      commands?.destroy();
      void stop().catch(() => {});
    };
    signal.addEventListener('abort', retire, { once: true });
    const finish = (termination: AgentAccessAcpProcessTermination) => {
      if (lifecycle.writableEnded || lifecycle.destroyed) return;
      lifecycle.end(termination);
      signal.removeEventListener('abort', retire);
    };
    child.onExit((code, exitSignal) => finish({ kind: 'exit', code, signal: exitSignal }));
    child.onError(() => finish({ kind: 'error', message: 'ACP provider process failed' }));

    const invoke = (operation: 'initialize' | 'close') => {
      signal.throwIfAborted();
      return runtime.invoke(pluginInstanceId, 'acpProcess', { operation, processId });
    };
    try {
      const returned = await runtime.invoke(pluginInstanceId, 'acpProcess', {
        operation: 'open',
        processId,
        pid: child.pid,
        cwd,
        stdout,
        stderr,
        lifecycle,
      });
      commands = openResultSchema.parse(returned).commands;
      signal.throwIfAborted();
      pump = (async () => {
        try {
          for await (const raw of commands) {
            signal.throwIfAborted();
            const command = commandSchema.parse(raw);
            if (command.kind === 'write') await writeApprovedLine(command.line);
            else await stop(command.graceMs, command.endStdin);
          }
        } finally {
          await stop();
        }
      })();
      void pump.catch(() => {});
    } catch (error) {
      retire();
      await shutdown;
      throw error;
    }
    return {
      initialize: () => invoke('initialize'),
      async close() {
        try {
          if (!signal.aborted) await invoke('close');
        } finally {
          await stop();
          await pump;
        }
      },
    };
  };
}
