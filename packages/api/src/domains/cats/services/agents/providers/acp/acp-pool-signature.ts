export interface AcpPoolSpawnSignatureInput {
  command: string;
  args: string[];
  cwd: string;
  env?: Record<string, string> | null;
  openCodeRuntimeConfig?: unknown;
  maxLiveProcesses: number;
  idleTtlMs: number;
  transport?: 'stdio' | 'httpstream';
  supportsMultiplexing?: boolean;
}

export function createAcpPoolSpawnSignature(input: AcpPoolSpawnSignatureInput): string {
  return JSON.stringify({
    cmd: input.command,
    args: input.args,
    cwd: input.cwd,
    env: input.env ?? null,
    openCodeRuntimeConfig: input.openCodeRuntimeConfig ?? null,
    maxLiveProcesses: input.maxLiveProcesses,
    idleTtlMs: input.idleTtlMs,
    transport: input.transport ?? 'stdio',
    supportsMultiplexing: input.supportsMultiplexing === true,
  });
}
