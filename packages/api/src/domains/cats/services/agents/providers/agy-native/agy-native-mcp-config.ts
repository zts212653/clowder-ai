import { randomUUID } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  CAT_CAFE_SPLIT_ENTRYPOINTS,
  resolveCatCafeNodeCommand,
} from '../../../../../../config/capabilities/mcp-constants.js';
import { validateAgyNativeConfigReceipt, writeAgyNativeConfigReceipt } from './agy-native-config-receipt.js';
import { AGY_NATIVE_CREDENTIAL_DIR, isLocalAgyCallbackUrl } from './agy-native-credential-file.js';
import {
  assertExistingServerIsHostOwned,
  credentialPathInProfile,
  requireHostEntrypoint,
} from './agy-native-mcp-ownership.js';

export interface AgyNativeMcpConfigInput {
  readonly profileHome: string;
  readonly runtimeRoot: string;
  readonly serverNames: readonly string[];
  /** Already resolved through canonical per-cat/project capability discovery. */
  readonly resolvedServers?: Readonly<Record<string, Record<string, unknown>>>;
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

function expectedServer(
  runtimeRoot: string,
  name: string,
  callback: NonNullable<AgyNativeMcpConfigInput['callback']>,
  home: string,
): StdioServerConfig {
  if (!CAT_CAFE_SPLIT_ENTRYPOINTS.has(name)) {
    throw new Error(`AGY native MCP server is not host-owned: ${name}`);
  }
  const entrypoint = CAT_CAFE_SPLIT_ENTRYPOINTS.get(name);
  if (!entrypoint) throw new Error(`AGY native MCP server has no built-in entrypoint: ${name}`);
  const path = requireHostEntrypoint(runtimeRoot, entrypoint);
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

function readExistingConfig(path: string, runtimeRoot: string, home: string, credential?: string): string | null {
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
  if (validateAgyNativeConfigReceipt(home, content, runtimeRoot, credential)) return content;
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
  const roots = new Set(
    Object.entries(record.mcpServers as Record<string, unknown>).map(([name, value]) =>
      assertExistingServerIsHostOwned(name, value, runtimeRoot, home, credential),
    ),
  );
  if (roots.size > 1) throw new Error('AGY native MCP config has mixed host bindings');
  return content;
}

/** Preserve account admission checks even though a turn never inherits this shared config. */
export function validateAgyNativeAccountMcp(profileHome: string, runtimeRoot: string): void {
  readExistingConfig(join(profileHome, '.gemini/config/mcp_config.json'), runtimeRoot, profileHome);
}

/** Trusted built-ins only. HTTP headers live in the owner-only per-turn profile and are reclaimed with it. */
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
  const credential = callback ? realpathSync(callback.credentialFile) : undefined;
  if (input.serverNames.length) requireDirectory(join(configDir, AGY_NATIVE_CREDENTIAL_DIR));
  const servers = input.resolvedServers
    ? Object.fromEntries(
        Object.entries(input.resolvedServers).map(([name, entry]) => {
          // The upstream remote transport uses serverUrl, not Claude's type/url envelope.
          if (entry.type === 'http' && typeof entry.url === 'string') {
            const { type: _type, url, ...rest } = entry;
            return [name, { ...rest, serverUrl: url }];
          }
          return [name, entry];
        }),
      )
    : Object.fromEntries(
        [...new Set(input.serverNames)]
          .sort()
          .map((name) => [name, expectedServer(runtimeRoot, name, requireCallbackBinding(callback), home)]),
      );
  const path = join(configDir, 'mcp_config.json');
  const lock = join(configDir, '.cat-cafe-mcp-config.lock');
  writeFileSync(lock, '', { flag: 'wx', mode: 0o600 });
  const temp = join(configDir, `.mcp-config-${randomUUID()}.tmp`);
  try {
    const existing = readExistingConfig(path, runtimeRoot, home, credential);
    const next = `${JSON.stringify({ mcpServers: servers }, null, 2)}\n`;
    if (existing === next) return path;
    writeFileSync(temp, next, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    // Revalidate retirement immediately before replacing the config; never overwrite another writer's bytes.
    if (readExistingConfig(path, runtimeRoot, home, credential) !== existing) {
      throw new Error('AGY native MCP binding changed during handoff');
    }
    renameSync(temp, path);
    writeAgyNativeConfigReceipt(home, next, runtimeRoot, credential);
  } finally {
    rmSync(temp, { force: true });
    rmSync(lock, { force: true });
  }
  return path;
}
