import { isServiceProcessCommand } from '../domains/services/service-lifecycle.js';
import {
  PORT_ENV_VARS,
  parseServicePort,
  type ServiceConfig,
  type ServiceManifest,
} from '../domains/services/service-manifest.js';

export type ServicePortPartition =
  | { ok: true; owned: number[]; foreign: number[] }
  | { ok: false; reason: 'port-probe-unavailable' };

export function createServicePortPartitioner(input: {
  lookupPidsByPort: (port: number) => Promise<number[]>;
  lookupProcessCommand: (pid: number) => Promise<string | null>;
  log: { warn(data: Record<string, unknown>, message: string): void };
}): (service: { id: string; port?: number; scripts?: { start?: string } }) => Promise<ServicePortPartition> {
  return async (service) => {
    if (!service.port) return { ok: true, owned: [], foreign: [] };
    let pids: number[];
    try {
      pids = await input.lookupPidsByPort(service.port);
    } catch (error) {
      input.log.warn({ err: error, serviceId: service.id, port: service.port }, 'service port probe failed');
      return { ok: false, reason: 'port-probe-unavailable' };
    }
    const owned: number[] = [];
    const foreign: number[] = [];
    for (const pid of pids) {
      const command = await input.lookupProcessCommand(pid);
      if (command && isServiceProcessCommand(command, service)) owned.push(pid);
      else foreign.push(pid);
    }
    return { ok: true, owned, foreign };
  };
}

export function servicePortProbeUnavailableError(port: number | undefined): { error: string } {
  return { error: `Service port probe unavailable for ${port ?? 'unknown'}` };
}

export function resolveConfiguredServicePort(
  service: ServiceManifest,
  config: ServiceConfig | undefined,
  env: NodeJS.ProcessEnv,
): number | undefined {
  if (typeof config?.port === 'number' && config.port > 0 && config.port <= 65535) return config.port;
  const portKey = PORT_ENV_VARS[service.id];
  const envPort = parseServicePort(portKey ? env[portKey]?.trim() : undefined);
  return envPort ?? service.port;
}

export async function findAvailableServicePort(
  preferredPort: number | undefined,
  lookupPidsByPort: (port: number) => Promise<number[]>,
): Promise<number | undefined> {
  if (!preferredPort) return undefined;
  for (let port = preferredPort; port <= 65535 && port < preferredPort + 100; port += 1) {
    try {
      if ((await lookupPidsByPort(port)).length === 0) return port;
    } catch {
      return preferredPort;
    }
  }
  return preferredPort;
}

export async function resolveSuggestedServicePort(input: {
  service: ServiceManifest;
  config?: ServiceConfig;
  env: NodeJS.ProcessEnv;
  lookupPidsByPort: (port: number) => Promise<number[]>;
}): Promise<number | undefined> {
  const configuredPort = resolveConfiguredServicePort(input.service, input.config, input.env);
  const portKey = PORT_ENV_VARS[input.service.id];
  const hasEnvPort = !!parseServicePort(portKey ? input.env[portKey]?.trim() : undefined);
  if (!configuredPort || input.config?.port || hasEnvPort) return configuredPort;
  return findAvailableServicePort(configuredPort, input.lookupPidsByPort);
}
