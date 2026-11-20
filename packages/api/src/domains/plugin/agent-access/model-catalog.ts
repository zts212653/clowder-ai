import { execFile } from 'node:child_process';
import {
  AGENT_ACCESS_PLUGIN_ID,
  type AgentAccessModelCatalog,
  agentAccessModelCatalogSchema,
} from '@clowder-ai/agent-contract';
import {
  type CatalogTarget,
  prepareAcpModelCatalogProbe,
  readClaudeModelCatalog,
} from '../../../routes/runtime-catalog-probe.js';
import { buildChildEnv } from '../../../utils/cli-spawn.js';
import { resolveWindowsSpawnPlan } from '../../../utils/cli-spawn-win.js';
import type { PluginRuntimeCarrierRouter } from '../carrier/runtime-carrier.js';
import type { PluginInventoryStore } from '../host-inventory/ports.js';

type InvokeResult = { stdout: string; code?: number | string | null };

function runTrusted(command: string, args: string[], cwd: string): Promise<InvokeResult> {
  const plan = process.platform === 'win32' ? resolveWindowsSpawnPlan(command, args) : { command, args };
  return new Promise((resolve) => {
    execFile(
      plan.command,
      plan.args,
      {
        cwd,
        env: buildChildEnv(undefined, { workingDirectory: cwd }),
        shell: 'shell' in plan ? plan.shell : false,
        windowsHide: true,
        timeout: 20_000,
        maxBuffer: 4_000_000,
        encoding: 'utf8',
      },
      (error, stdout) => resolve({ stdout, code: error ? (error.code ?? 1) : 0 }),
    );
  });
}

function generationOf(instance: {
  pluginInstanceId: string;
  packageDigest: string;
  lifecycleRevision: number;
}): string {
  return [instance.pluginInstanceId, instance.packageDigest, instance.lifecycleRevision].join(':');
}

/** Host-side generation fence for cache keys; no plugin invocation. */
export function createAgentAccessModelCatalogGeneration(inventory: Pick<PluginInventoryStore, 'readCurrentAuthority'>) {
  return async (): Promise<string | undefined> => {
    const instance = (await inventory.readCurrentAuthority(AGENT_ACCESS_PLUGIN_ID))?.instance;
    if (!instance || instance.activationState !== 'enabled' || instance.runtimeState !== 'healthy') return undefined;
    return generationOf(instance);
  };
}

/**
 * The active package owns model discovery and catalog projection. The Host
 * keeps executable, cwd, credentials and native I/O in provider-specific ports.
 */
export function createAgentAccessModelCatalogDiscovery(
  inventory: Pick<PluginInventoryStore, 'readCurrentAuthority'>,
  runtime: Pick<PluginRuntimeCarrierRouter, 'invoke'>,
) {
  const readGeneration = createAgentAccessModelCatalogGeneration(inventory);
  return async (target: CatalogTarget): Promise<AgentAccessModelCatalog | undefined> => {
    const instance = (await inventory.readCurrentAuthority(AGENT_ACCESS_PLUGIN_ID))?.instance;
    if (!instance || instance.activationState !== 'enabled' || instance.runtimeState !== 'healthy') return undefined;
    const generation = generationOf(instance);
    if (target.generation && target.generation !== generation) return undefined;
    const assertCurrent = async () => {
      if ((await readGeneration()) !== generation) throw new Error('session_implementation_unavailable');
    };
    const acp = target.kind === 'acp' ? prepareAcpModelCatalogProbe(target) : undefined;
    const input = {
      operation: 'discover_model_catalog',
      client: target.kind,
      input: target.model ? { model: target.model } : {},
    };
    const ports =
      target.kind === 'codex'
        ? {
            async launch(request: { args: string[]; cwd?: string }) {
              if (
                !Array.isArray(request.args) ||
                request.args.length !== 2 ||
                request.args[0] !== 'debug' ||
                request.args[1] !== 'models' ||
                request.cwd !== undefined
              )
                throw new Error('codex_model_catalog_request_not_approved');
              await assertCurrent();
              return runTrusted(target.command, ['debug', 'models'], target.cwd);
            },
          }
        : acp
          ? {
              async describeAcp() {
                await assertCurrent();
                return acp.describe();
              },
              async selectAcpModel(model: string) {
                await assertCurrent();
                return acp.select(model);
              },
            }
          : {
              async readClaude() {
                await assertCurrent();
                return readClaudeModelCatalog(target);
              },
            };
    try {
      const result = await runtime.invoke(instance.pluginInstanceId, 'discoverModelCatalog', { input, ...ports });
      await assertCurrent();
      return agentAccessModelCatalogSchema.parse(result);
    } finally {
      await acp?.close();
    }
  };
}
