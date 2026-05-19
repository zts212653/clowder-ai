import { isServiceProcessCommand } from '../domains/services/service-lifecycle.js';

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
