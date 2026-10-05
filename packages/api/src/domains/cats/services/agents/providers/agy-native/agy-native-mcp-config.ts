import { randomUUID } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import {
  CAT_CAFE_SPLIT_ENTRYPOINTS,
  resolveCatCafeNodeCommand,
} from '../../../../../../config/capabilities/mcp-constants.js';
import { AGY_NATIVE_CREDENTIAL_DIR, isLocalAgyCallbackUrl } from './agy-native-credential-file.js';
import { AGY_NATIVE_HOST_MCP_SERVERS } from './agy-native-policy.js';

export interface AgyNativeMcpConfigInput {
  readonly profileHome: string;
  readonly runtimeRoot: string;
  readonly serverNames: readonly string[];
  readonly callback?: { readonly apiUrl: string; readonly credentialFile: string };
}

interface StdioServerConfig {
  readonly command: string;
  readonly args: readonly [string];
  readonly env: { readonly CAT_CAFE_API_URL: string; readonly CAT_CAFE_CREDENTIAL_FILE: string };
}

function requireDirectory(path: string): void {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) throw new Error(`AGY native MCP profile path must not be a symlink: ${path}`);
  if (!stat.isDirectory()) throw new Error(`AGY native MCP profile path must be a directory: ${path}`);
}

function credentialPathInProfile(home: string, path: string): boolean {
  const dir = join(home, '.gemini', 'config', AGY_NATIVE_CREDENTIAL_DIR);
  return (
    dirname(path) === dir && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.json$/.test(basename(path))
  );
}

function expectedServer(
  runtimeRoot: string,
  name: string,
  callback: NonNullable<AgyNativeMcpConfigInput['callback']>,
  home: string,
): StdioServerConfig {
  if (!AGY_NATIVE_HOST_MCP_SERVERS.includes(name as (typeof AGY_NATIVE_HOST_MCP_SERVERS)[number])) {
    throw new Error(`AGY native MCP server is not host-owned: ${name}`);
  }
  const entrypoint = CAT_CAFE_SPLIT_ENTRYPOINTS.get(name);
  if (!entrypoint) throw new Error(`AGY native MCP server has no built-in entrypoint: ${name}`);
  const path = join(runtimeRoot, 'packages', 'mcp-server', 'dist', entrypoint);
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isFile())
    throw new Error(`AGY native MCP entrypoint is not a regular host-owned file: ${path}`);
  if (!isLocalAgyCallbackUrl(callback.apiUrl)) throw new Error('AGY native MCP callback URL must be loopback');
  if (lstatSync(callback.credentialFile).isSymbolicLink())
    throw new Error('AGY native MCP credential file is a symlink');
  const credentialFile = realpathSync(callback.credentialFile);
  if (!credentialPathInProfile(home, credentialFile))
    throw new Error('AGY native MCP credential file is outside profile');
  if (!lstatSync(credentialFile).isFile()) throw new Error('AGY native MCP credential file is not regular');
  return {
    command: realpathSync(resolveCatCafeNodeCommand()),
    args: [realpathSync(path)],
    env: { CAT_CAFE_API_URL: callback.apiUrl, CAT_CAFE_CREDENTIAL_FILE: credentialFile },
  };
}

function requireCallbackBinding(
  callback: AgyNativeMcpConfigInput['callback'],
): NonNullable<AgyNativeMcpConfigInput['callback']> {
  if (!callback) throw new Error('AGY native MCP requires callback binding');
  return callback;
}

function assertExistingServerIsHostOwned(name: string, value: unknown, runtimeRoot: string, home: string): void {
  if (!AGY_NATIVE_HOST_MCP_SERVERS.includes(name as (typeof AGY_NATIVE_HOST_MCP_SERVERS)[number]))
    throw new Error(`AGY native MCP server is not host-owned: ${name}`);
  const entrypoint = CAT_CAFE_SPLIT_ENTRYPOINTS.get(name);
  if (!entrypoint) throw new Error(`AGY native MCP server has no built-in entrypoint: ${name}`);
  const entrypointPath = join(runtimeRoot, 'packages', 'mcp-server', 'dist', entrypoint);
  if (lstatSync(entrypointPath).isSymbolicLink()) throw new Error(`AGY native MCP entrypoint is a symlink: ${name}`);
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`AGY native MCP server config is invalid: ${name}`);
  const server = value as Record<string, unknown>;
  const env = server.env;
  if (!env || typeof env !== 'object' || Array.isArray(env))
    throw new Error(`AGY native MCP server env is invalid: ${name}`);
  const values = env as Record<string, unknown>;
  const credentialFile = values.CAT_CAFE_CREDENTIAL_FILE;
  if (
    Object.keys(server).sort().join(',') !== 'args,command,env' ||
    server.command !== realpathSync(resolveCatCafeNodeCommand()) ||
    !Array.isArray(server.args) ||
    server.args.length !== 1 ||
    server.args[0] !== realpathSync(entrypointPath) ||
    Object.keys(values).sort().join(',') !== 'CAT_CAFE_API_URL,CAT_CAFE_CREDENTIAL_FILE' ||
    typeof values.CAT_CAFE_API_URL !== 'string' ||
    !isLocalAgyCallbackUrl(values.CAT_CAFE_API_URL) ||
    typeof credentialFile !== 'string' ||
    !credentialPathInProfile(home, credentialFile)
  ) {
    throw new Error(`AGY native MCP server is not host-owned: ${name}`);
  }
}

function readExistingConfig(path: string, runtimeRoot: string, home: string): string | null {
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  if (stat.isSymbolicLink() || !stat.isFile())
    throw new Error('AGY native MCP config must be a regular host-owned file');
  const content = readFileSync(path, 'utf8');
  // The official CLI creates a zero-byte placeholder during OAuth onboarding.
  // Replace only that exact empty file; malformed non-empty config still fails closed.
  if (content.length === 0) return null;
  const parsed: unknown = JSON.parse(content);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new Error('AGY native MCP config is invalid');
  const record = parsed as Record<string, unknown>;
  if (
    Object.keys(record).length !== 1 ||
    !record.mcpServers ||
    typeof record.mcpServers !== 'object' ||
    Array.isArray(record.mcpServers)
  ) {
    throw new Error('AGY native MCP config contains untrusted fields');
  }
  for (const [name, value] of Object.entries(record.mcpServers as Record<string, unknown>)) {
    assertExistingServerIsHostOwned(name, value, runtimeRoot, home);
  }
  return content;
}

/** Only launch built-in Clowder AI servers from the trusted runtime root; no callback token is stored. */
export function materializeAgyNativeMcpConfig(input: AgyNativeMcpConfigInput): string {
  const suppliedHome = resolve(input.profileHome);
  requireDirectory(suppliedHome);
  const home = realpathSync(suppliedHome);
  if (home === realpathSync(homedir())) throw new Error('AGY native MCP requires an isolated HOME');
  const configDir = join(home, '.gemini', 'config');
  requireDirectory(join(home, '.gemini'));
  requireDirectory(configDir);
  const runtimeRoot = realpathSync(input.runtimeRoot);
  const callback = input.serverNames.length ? requireCallbackBinding(input.callback) : undefined;
  if (input.serverNames.length) requireDirectory(join(configDir, AGY_NATIVE_CREDENTIAL_DIR));
  const servers = Object.fromEntries(
    [...new Set(input.serverNames)]
      .sort()
      .map((name) => [name, expectedServer(runtimeRoot, name, requireCallbackBinding(callback), home)]),
  );
  const path = join(configDir, 'mcp_config.json');
  const existing = readExistingConfig(path, runtimeRoot, home);
  const next = `${JSON.stringify({ mcpServers: servers }, null, 2)}\n`;
  if (existing === next) return path;
  const temp = join(configDir, `.mcp-config-${randomUUID()}.tmp`);
  writeFileSync(temp, next, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  try {
    renameSync(temp, path);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
  return path;
}
