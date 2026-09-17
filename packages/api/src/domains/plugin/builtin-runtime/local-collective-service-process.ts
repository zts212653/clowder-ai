import { spawn } from 'node:child_process';
import { closeSync, openSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export interface LocalCollectiveServiceSpawnSpec {
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly logPath: string;
}

export interface LocalCollectiveServiceHealth {
  readonly serviceInstanceId: string;
  readonly bootstrapNeeded: boolean;
  readonly onboardingComplete: boolean;
  readonly providerReady: boolean;
}

export function configuredLocalCollectiveServiceUrl(env: NodeJS.ProcessEnv): string {
  const port = env.COLLECTIVE_SERVICE_PORT?.trim() || '5201';
  return `http://127.0.0.1:${port}`;
}

export function validateLocalCollectiveServiceUrl(value: string): string {
  const url = new URL(value);
  if (
    url.protocol !== 'http:' ||
    !['127.0.0.1', 'localhost'].includes(url.hostname) ||
    !url.port ||
    ['3001', '3002'].includes(url.port) ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  ) {
    throw new Error('Managed Collective Service URL must be an explicit non-runtime loopback port');
  }
  return url.origin;
}

export function isLocalCollectiveServiceHealth(
  value: unknown,
): value is Omit<LocalCollectiveServiceHealth, 'providerReady'> & { readonly ok: true } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const raw = value as Record<string, unknown>;
  return (
    raw.ok === true &&
    typeof raw.serviceInstanceId === 'string' &&
    typeof raw.bootstrapNeeded === 'boolean' &&
    typeof raw.onboardingComplete === 'boolean'
  );
}

export function readGitHubProviderReady(value: unknown): boolean | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const providers = (value as Record<string, unknown>).providers;
  if (!Array.isArray(providers)) return undefined;
  const github = providers.find(
    (provider) => provider && typeof provider === 'object' && (provider as Record<string, unknown>).id === 'github',
  ) as Record<string, unknown> | undefined;
  return typeof github?.ready === 'boolean' ? github.ready : undefined;
}

export function isMissingFile(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

export function isExistingFile(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'EEXIST';
}

export function resolveLocalCollectiveServiceCliPath(): string {
  return fileURLToPath(import.meta.resolve('@cat-cafe/collective-service/cli'));
}

export async function spawnDetachedCollectiveService(
  spec: LocalCollectiveServiceSpawnSpec,
): Promise<{ readonly pid: number }> {
  const logFd = openSync(spec.logPath, 'a', 0o600);
  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(spec.command, [...spec.args], {
      detached: process.platform !== 'win32',
      env: { ...spec.env },
      stdio: ['ignore', logFd, logFd],
      windowsHide: true,
    });
  } finally {
    closeSync(logFd);
  }
  await new Promise<void>((resolveSpawn, rejectSpawn) => {
    const onSpawn = () => {
      child.off('error', onError);
      resolveSpawn();
    };
    const onError = (error: Error) => {
      child.off('spawn', onSpawn);
      rejectSpawn(error);
    };
    child.once('spawn', onSpawn);
    child.once('error', onError);
  });
  if (child.pid === undefined) throw new Error('Collective Service process did not receive a pid');
  child.unref();
  return { pid: child.pid };
}
