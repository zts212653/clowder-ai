import { fileURLToPath } from 'node:url';
import { catRegistry } from '@cat-cafe/shared';
import {
  safeNativeStartup,
  discoverNativeRuntimes as scanNativeRuntimes,
} from '@clowder-ai/agent-access/discovery/native-runtimes';
import type { AgentAccessDetectionContext } from '@clowder-ai/agent-contract';
import { getRegisteredAcpConfig } from '../config/cat-config-loader.js';
import { resolveCliCommand } from '../utils/cli-resolve.js';
import { nativeRuntimeReadiness } from './native-runtime-readiness.js';

export { safeNativeStartup };

export function nativeRuntimeDetectionContext(projectRoot: string, redactStartup = false): AgentAccessDetectionContext {
  return {
    projectRoot,
    piBridgeEntry: fileURLToPath(
      new URL('../domains/cats/services/agents/providers/pi/pi-acp-bridge.js', import.meta.url),
    ),
    members: Object.values(catRegistry.getAllConfigs()).map((cat) => {
      const acp = getRegisteredAcpConfig(cat.id, projectRoot, { persistMigrations: false });
      return {
        id: cat.id,
        clientId: cat.clientId,
        displayName: cat.displayName,
        defaultModel: cat.defaultModel,
        agentProvider: cat.agentProvider,
        agyProfile: cat.agyProfile && {
          carrier: cat.agyProfile.carrier,
          enabled: cat.agyProfile.enabled,
          model: cat.agyProfile.model,
        },
        env: cat.env?.DSH_HOME ? { DSH_HOME: cat.env.DSH_HOME } : undefined,
        acp: acp && {
          command: redactStartup && !safeNativeStartup(acp.command, []) ? '' : acp.command,
          startupArgs: !redactStartup || safeNativeStartup(acp.command, acp.startupArgs) ? acp.startupArgs : ['token'],
          agentProvider: acp.agentProvider,
          transport: acp.transport,
        },
      };
    }),
  };
}

export function discoverNativeRuntimes(projectRoot: string, commandFor = resolveCliCommand) {
  return scanNativeRuntimes(nativeRuntimeDetectionContext(projectRoot), commandFor);
}

/** Bounded native login checks, without prompts, model requests, or refreshing credentials. */
export async function discoverNativeRuntimesWithReadiness(root: string, refresh = false) {
  const found = await discoverNativeRuntimes(root);
  const runtimes = await Promise.all(
    found.runtimes.map(async (runtime) => ({
      ...runtime,
      readiness: await nativeRuntimeReadiness(runtime, root, refresh),
    })),
  );
  return { runtimes, authenticationStatus: 'local_checked' };
}
