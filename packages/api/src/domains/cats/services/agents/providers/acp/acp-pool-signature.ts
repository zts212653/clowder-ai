export interface AcpPoolSpawnSignatureInput {
  command: string;
  args: string[];
  cwd: string;
  bootstrapIsolation?: string;
  env?: Record<string, string> | null;
  openCodeRuntimeConfig?: unknown;
  contextPolicy?: unknown;
  maxLiveProcesses: number;
  idleTtlMs: number;
  transport?: 'stdio' | 'httpstream';
  supportsMultiplexing?: boolean;
  sessionPolicy?: unknown;
}

export function createAcpPoolSpawnSignature(input: AcpPoolSpawnSignatureInput): string {
  return JSON.stringify({
    cmd: input.command,
    args: input.args,
    cwd: input.cwd,
    bootstrapIsolation: input.bootstrapIsolation ?? null,
    env: input.env ?? null,
    openCodeRuntimeConfig: input.openCodeRuntimeConfig ?? null,
    contextPolicy: input.contextPolicy ?? null,
    maxLiveProcesses: input.maxLiveProcesses,
    idleTtlMs: input.idleTtlMs,
    transport: input.transport ?? 'stdio',
    supportsMultiplexing: input.supportsMultiplexing === true,
    ...(input.sessionPolicy ? { sessionPolicy: input.sessionPolicy } : {}),
  });
}
