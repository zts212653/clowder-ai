export interface AcpPoolSpawnSignatureInput {
  command: string;
  args: string[];
  cwd: string;
  bootstrapIsolation?: string;
  env?: Record<string, string> | null;
  environmentFingerprint?: string;
  shell?: true | string;
  openCodeRuntimeConfig?: unknown;
  contextPolicy?: unknown;
  maxLiveProcesses: number;
  idleTtlMs: number;
  transport?: 'stdio' | 'httpstream';
  supportsMultiplexing?: boolean;
  protocolAdapter?: string;
  permissionPolicy?: 'deny' | 'auto_allow';
  sessionPolicy?: unknown;
}

export function createAcpPoolSpawnSignature(input: AcpPoolSpawnSignatureInput): string {
  return JSON.stringify({
    cmd: input.command,
    args: input.args,
    ...(input.shell !== undefined ? { shell: input.shell } : {}),
    cwd: input.cwd,
    bootstrapIsolation: input.bootstrapIsolation ?? null,
    env: input.env ?? null,
    ...(input.environmentFingerprint ? { environmentFingerprint: input.environmentFingerprint } : {}),
    openCodeRuntimeConfig: input.openCodeRuntimeConfig ?? null,
    contextPolicy: input.contextPolicy ?? null,
    maxLiveProcesses: input.maxLiveProcesses,
    idleTtlMs: input.idleTtlMs,
    transport: input.transport ?? 'stdio',
    supportsMultiplexing: input.supportsMultiplexing === true,
    protocolAdapter: input.protocolAdapter ?? null,
    permissionPolicy: input.permissionPolicy ?? null,
    ...(input.sessionPolicy ? { sessionPolicy: input.sessionPolicy } : {}),
  });
}
