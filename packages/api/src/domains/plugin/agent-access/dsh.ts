import { AGENT_ACCESS_PLUGIN_ID } from '@clowder-ai/agent-contract';
import type { AgentAccessAcpChildHandle, AgentAccessAcpChildTermination } from '@clowder-ai/agent-contract/acp';
import { z } from 'zod';
import {
  ACP_CHILD_SHUTDOWN_GRACE_MS,
  type AcpClientConfig,
  launchAcpChild,
} from '../../cats/services/agents/providers/acp/AcpClient.js';
import type { PluginRuntimeCarrierRouter } from '../carrier/runtime-carrier.js';
import type { PluginInventoryStore } from '../host-inventory/ports.js';

const resultSchema = z.object({ sessionId: z.string().min(1) });

export function createAgentAccessDshConnectionTest(
  inventory: Pick<PluginInventoryStore, 'readCurrentAuthority'>,
  runtime: Pick<PluginRuntimeCarrierRouter, 'invoke'>,
) {
  return async (config: AcpClientConfig, cwd: string, preferences: { model?: string; effort?: string }) => {
    const selected = (await inventory.readCurrentAuthority(AGENT_ACCESS_PLUGIN_ID))?.instance;
    if (selected?.activationState !== 'enabled' || selected.runtimeState !== 'healthy') {
      throw Error('dsh_setup_unavailable');
    }
    let connection: ReturnType<typeof launchAcpChild>['child'] | undefined;
    let shuttingDown: Promise<void> | undefined;
    let launched = false;
    let finished = false;
    function shutdown(graceMs = ACP_CHILD_SHUTDOWN_GRACE_MS, endStdin = false) {
      shuttingDown ??= connection?.shutdown(graceMs, endStdin) ?? Promise.resolve();
      return shuttingDown;
    }
    try {
      const result = await runtime.invoke(selected.pluginInstanceId, 'testDshConnection', {
        input: { cwd, ...preferences },
        async launch(): Promise<AgentAccessAcpChildHandle> {
          if (launched) throw Error('dsh_setup_start_failed');
          launched = true;
          const current = (await inventory.readCurrentAuthority(AGENT_ACCESS_PLUGIN_ID))?.instance;
          if (
            finished ||
            current?.pluginInstanceId !== selected.pluginInstanceId ||
            current.packageDigest !== selected.packageDigest ||
            current.lifecycleRevision !== selected.lifecycleRevision ||
            current.runtimeState !== 'healthy'
          ) {
            throw Error('dsh_setup_unavailable');
          }
          const { child } = launchAcpChild(config, () => {});
          connection = child;
          if (!child.stdout) throw Error('dsh_setup_start_failed');
          const terminated = new Promise<AgentAccessAcpChildTermination>((resolve) => {
            child.onError((error) => resolve({ kind: 'error', error }));
            child.onExit((code, signal) => resolve({ kind: 'exit', code, signal }));
          });
          return {
            pid: child.pid,
            stdout: child.stdout,
            stderr: child.stderr,
            isWritable: child.isWritable,
            isKilled: child.isKilled,
            write: child.write,
            termination: () => terminated,
            shutdown,
          };
        },
      });
      return resultSchema.parse(result);
    } finally {
      finished = true;
      if (connection) await shutdown();
    }
  };
}
