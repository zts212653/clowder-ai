import { createModuleLogger } from '../../../infrastructure/logger.js';

const log = createModuleLogger('plugin/package-staging');
// Diagnostic metadata stays private and does not alter the error/cause contract.
const failurePhases = new WeakMap<Error, string>();
const STAGING_PHASES = ['copy', 'digest', 'preflight', 'list', 'extract', 'tree', 'seal'] as const;
export type PackageStagingPhase = (typeof STAGING_PHASES)[number];

export function recordPackageStagingPhase<T extends Error>(error: T, phase: string): T {
  failurePhases.set(error, phase);
  return error;
}

/** Read only Host-recorded metadata; error properties cannot forge this value. */
export function packageStagingPhase(error: unknown): PackageStagingPhase | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const phase = failurePhases.get(error as Error);
  return STAGING_PHASES.find((known) => known === phase);
}

function describeStagingError(error: unknown, depth = 0): Record<string, unknown> {
  if (!(error instanceof Error)) return { name: 'NonError', type: typeof error };
  const name = typeof error.name === 'string' ? error.name.slice(0, 128) : 'Error';
  if (depth >= 4) return { name, truncated: true };
  const diagnostic: Record<string, unknown> = {
    name,
    message: typeof error.message === 'string' ? error.message.slice(0, 512) : 'Non-string error message',
  };
  const subprocess = error as NodeJS.ErrnoException & { signal?: unknown; stderr?: unknown };
  if (typeof subprocess.code === 'string') diagnostic.code = subprocess.code.slice(0, 128);
  if (typeof subprocess.code === 'number') diagnostic.code = subprocess.code;
  if (typeof subprocess.signal === 'string') diagnostic.signal = subprocess.signal;
  if (typeof subprocess.stderr === 'string') diagnostic.stderr = subprocess.stderr.slice(0, 2048);
  if (error.cause !== undefined) diagnostic.cause = describeStagingError(error.cause, depth + 1);
  return diagnostic;
}

export function reportPackageArchiveFailure(packageDigest: string, error: unknown): void {
  try {
    log.warn(
      {
        phase: error instanceof Error ? (failurePhases.get(error) ?? 'admission') : 'admission',
        platform: process.platform,
        packageDigest,
        error: describeStagingError(error),
      },
      'Plugin package staging failed',
    );
  } catch {
    // A diagnostic failure must never replace the original rejection or cleanup.
  }
}
