import { createHash } from 'node:crypto';
import { acpLaunchArtifacts } from './acp-launch-fingerprint.js';

export interface AcpPoolSpawnSignatureInput {
  command: string;
  args: string[];
  cwd: string;
  env?: Record<string, string> | null;
  openCodeRuntimeConfig?: unknown;
  contextPolicy?: unknown;
  maxLiveProcesses: number;
  idleTtlMs: number;
  transport?: 'stdio' | 'httpstream';
  supportsMultiplexing?: boolean;
}

export function createAcpPoolSpawnSignature(input: AcpPoolSpawnSignatureInput): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        launchArtifacts: acpLaunchArtifacts(input.command, input.args, input.cwd),
        cmd: input.command,
        args: input.args,
        cwd: input.cwd,
        env: input.env ?? null,
        openCodeRuntimeConfig: input.openCodeRuntimeConfig ?? null,
        contextPolicy: input.contextPolicy ?? null,
        maxLiveProcesses: input.maxLiveProcesses,
        idleTtlMs: input.idleTtlMs,
        transport: input.transport ?? 'stdio',
        supportsMultiplexing: input.supportsMultiplexing === true,
      }),
    )
    .digest('hex');
}
