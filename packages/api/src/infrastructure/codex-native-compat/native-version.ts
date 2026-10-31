import { execFile } from 'node:child_process';
import { existsSync, realpathSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
/** First launch of a freshly installed binary can be slow (system scan); 2s used to break the whole chain. */
export const CODEX_VERSION_TIMEOUT_MS = 20_000;
const VERSION_PATTERN = /^codex-cli \d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
const versions = new Map<string, Promise<string>>();

function fileIdentity(path: string): string {
  const stat = statSync(path);
  return `${path}:${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
}

/**
 * Identity of the installed carrier: the entry file, its npm package manifest and the platform
 * package that holds the native binary the npm wrapper actually runs. Any install, downgrade or
 * half-finished swap changes one of them, so the version is read again; an unchanged install never
 * spawns `--version` twice.
 */
export function codexBinaryFingerprint(executable: string): string {
  const path = realpathSync(executable);
  const packageRoot = dirname(dirname(path));
  const parts = [path, join(packageRoot, 'package.json')];
  parts.push(join(packageRoot, 'node_modules', '@openai', `codex-${process.platform}-${process.arch}`, 'package.json'));
  return parts
    .filter((part, index) => index === 0 || existsSync(part))
    .map(fileIdentity)
    .join('|');
}

export function readCodexNativeVersion(executable: string, env: NodeJS.ProcessEnv): Promise<string> {
  const key = codexBinaryFingerprint(executable);
  const cached = versions.get(key);
  if (cached) return cached;
  const pending = run(realpathSync(executable), ['--version'], {
    env,
    encoding: 'utf8',
    timeout: CODEX_VERSION_TIMEOUT_MS,
  }).then(
    ({ stdout }) => {
      const version = stdout.trim();
      if (!VERSION_PATTERN.test(version)) throw new Error('codex_native_version_unrecognized');
      return version;
    },
    (error: NodeJS.ErrnoException & { killed?: boolean }) => {
      throw new Error(error.killed ? 'codex_native_version_timeout' : 'codex_native_version_unavailable', {
        cause: error,
      });
    },
  );
  versions.set(key, pending);
  // A failed read is retried on the next launch instead of pinning the failure.
  pending.catch(() => versions.delete(key));
  return pending;
}

/** Test seam only. */
export function resetCodexNativeVersionCache(): void {
  versions.clear();
}
