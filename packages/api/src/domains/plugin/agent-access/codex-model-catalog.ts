import { execFile } from 'node:child_process';
import {
  AGENT_ACCESS_PLUGIN_ID,
  agentAccessModelCatalogSchema,
  type AgentAccessModelCatalog,
} from '@clowder-ai/agent-contract';
import { buildChildEnv } from '../../../utils/cli-spawn.js';
import { resolveWindowsSpawnPlan } from '../../../utils/cli-spawn-win.js';
import type { PluginRuntimeCarrierRouter } from '../carrier/runtime-carrier.js';
import type { PluginInventoryStore } from '../host-inventory/ports.js';

export interface CodexModelCatalogTarget {
  command: string;
  cwd: string;
  model?: string;
}

type InvokeResult = { stdout: string; stderr?: string; code?: number | string | null };

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
      (error, stdout, stderr) => resolve({ stdout, stderr, code: error?.code ?? 0 }),
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
export function createAgentAccessCodexModelCatalogGeneration(
  inventory: Pick<PluginInventoryStore, 'readCurrentAuthority'>,
) {
  return async (): Promise<string | undefined> => {
    const instance = (await inventory.readCurrentAuthority(AGENT_ACCESS_PLUGIN_ID))?.instance;
    if (!instance || instance.activationState !== 'enabled' || instance.runtimeState !== 'healthy') return undefined;
    return generationOf(instance);
  };
}

/**
 * The active package owns Codex's discovery request shape and catalog parsing.
 * Host resolves the trusted executable/cwd, provides only the approved
 * `debug models` execution callback, and keeps account/env authority.
 */
export function createAgentAccessCodexModelCatalogDiscovery(
  inventory: Pick<PluginInventoryStore, 'readCurrentAuthority'>,
  runtime: Pick<PluginRuntimeCarrierRouter, 'invoke'>,
) {
  return async (target: CodexModelCatalogTarget): Promise<AgentAccessModelCatalog | undefined> => {
    const instance = (await inventory.readCurrentAuthority(AGENT_ACCESS_PLUGIN_ID))?.instance;
    if (!instance || instance.activationState !== 'enabled' || instance.runtimeState !== 'healthy') return undefined;
    const expectedGeneration = generationOf(instance);
    const result = await runtime.invoke(instance.pluginInstanceId, 'discoverModelCatalog', {
      input: { cwd: target.cwd, ...(target.model ? { model: target.model } : {}) },
      async launch(request: { args: string[]; cwd?: string }): Promise<InvokeResult> {
        if (!Array.isArray(request.args) || request.args.length !== 2 || request.args[0] !== 'debug' || request.args[1] !== 'models')
          throw new Error('codex_model_catalog_request_not_approved');
        const current = (await inventory.readCurrentAuthority(AGENT_ACCESS_PLUGIN_ID))?.instance;
        if (
          !current ||
          current.pluginInstanceId !== instance.pluginInstanceId ||
          generationOf(current) !== expectedGeneration ||
          current.runtimeState !== 'healthy'
        )
          throw new Error('session_implementation_unavailable');
        return runTrusted(target.command, ['debug', 'models'], request.cwd ?? target.cwd);
      },
    });
    return agentAccessModelCatalogSchema.parse(result);
  };
}
