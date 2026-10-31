import { execFileSync } from 'node:child_process';
import { lstatSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import {
  CAT_CAFE_SPLIT_ENTRYPOINTS,
  resolveCatCafeNodeCommand,
} from '../../../../../../config/capabilities/mcp-constants.js';
import { AGY_NATIVE_CREDENTIAL_DIR, isLocalAgyCallbackUrl } from './agy-native-credential-file.js';

export function credentialPathInProfile(home: string, path: string): boolean {
  return (
    dirname(path) === join(home, '.gemini', 'config', AGY_NATIVE_CREDENTIAL_DIR) &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.json$/.test(basename(path))
  );
}

export function requireHostEntrypoint(root: string, entrypoint: string): string {
  const path = join(root, 'packages', 'mcp-server', 'dist', entrypoint);
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isFile() || realpathSync(path) !== path) {
    throw new Error('AGY native MCP entrypoint must be a regular host-owned file without symlinks');
  }
  return path;
}

export function commonGitDirectory(root: string): string {
  // Ignore caller Git redirection; only the named checkout determines repository ownership.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', root, ...args], {
      env,
      encoding: 'utf8',
      timeout: 5000,
      maxBuffer: 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  if (realpathSync(git('rev-parse', '--show-toplevel')) !== root)
    throw new Error('AGY MCP binding is not a repository root');
  const common = realpathSync(git('rev-parse', '--path-format=absolute', '--git-common-dir'));
  if (!git('worktree', 'list', '--porcelain').split('\n').includes(`worktree ${root}`)) {
    throw new Error('AGY MCP binding is not a registered repository worktree');
  }
  return common;
}

export function requireRetiredCredential(path: string): void {
  try {
    lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  // A dangling symlink also exists and is never evidence of retirement.
  throw new Error('AGY native MCP binding is active or has an unretired credential');
}

/** A stale built-in binding may move only between registered worktrees of this same repository. */
export function assertExistingServerIsHostOwned(
  name: string,
  value: unknown,
  runtimeRoot: string,
  home: string,
  newCredential?: string,
): string {
  if (!CAT_CAFE_SPLIT_ENTRYPOINTS.has(name)) {
    throw new Error(`AGY native MCP server is not host-owned: ${name}`);
  }
  const entrypoint = CAT_CAFE_SPLIT_ENTRYPOINTS.get(name);
  if (!entrypoint || !value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('AGY MCP binding is invalid');
  const server = value as Record<string, unknown>;
  const env = server.env;
  if (!env || typeof env !== 'object' || Array.isArray(env)) throw new Error('AGY MCP binding env is invalid');
  const values = env as Record<string, unknown>;
  const path = Array.isArray(server.args) && server.args.length === 1 ? server.args[0] : undefined;
  const credential = values.CAT_CAFE_CREDENTIAL_FILE;
  const suffix = `/packages/mcp-server/dist/${entrypoint}`;
  if (
    Object.keys(server).sort().join(',') !== 'args,command,env' ||
    server.command !== realpathSync(resolveCatCafeNodeCommand()) ||
    typeof path !== 'string' ||
    !isAbsolute(path) ||
    !path.endsWith(suffix) ||
    Object.keys(values).sort().join(',') !== 'CAT_CAFE_API_URL,CAT_CAFE_CREDENTIAL_FILE' ||
    typeof values.CAT_CAFE_API_URL !== 'string' ||
    !isLocalAgyCallbackUrl(values.CAT_CAFE_API_URL) ||
    typeof credential !== 'string' ||
    !credentialPathInProfile(home, credential)
  ) {
    throw new Error(`AGY native MCP server is not host-owned: ${name}`);
  }
  const oldRoot = resolve(path.slice(0, -suffix.length));
  if (requireHostEntrypoint(oldRoot, entrypoint) !== path) throw new Error('AGY MCP binding path is not canonical');
  if (oldRoot !== runtimeRoot) {
    if (realpathSync(oldRoot) !== oldRoot || commonGitDirectory(oldRoot) !== commonGitDirectory(runtimeRoot)) {
      throw new Error('AGY native MCP binding belongs to a different repository');
    }
    requireRetiredCredential(credential);
  } else if (credential !== newCredential) {
    requireRetiredCredential(credential);
  }
  return oldRoot;
}
