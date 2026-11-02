import { isIP } from 'node:net';
import { createModuleLogger } from '../infrastructure/logger.js';
import { buildChildEnv } from './cli-spawn.js';
import { readWindowsSystemProxy, type WindowsSystemProxy } from './windows-system-proxy.js';

const log = createModuleLogger('codex-network');

/** Pure projection of an already composed child environment; no provider/config authority. */
export function deriveCodexNetworkEnvironment(
  input: Readonly<NodeJS.ProcessEnv>,
  platform: NodeJS.Platform,
  systemProxy?: WindowsSystemProxy | null,
) {
  const aliases = Object.entries(input).filter(([key]) => key.toUpperCase() === 'NO_PROXY');
  const existing = aliases.flatMap(([, value]) =>
    (value ?? '')
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean),
  );
  let exceptions = existing;
  if (!existing.length && platform === 'win32') {
    if (systemProxy === undefined) return { env: { ...input }, diagnostic: 'windows_system_proxy_not_read' };
    if (systemProxy === null) return { env: { ...input }, diagnostic: 'windows_system_proxy_read_failed' };
    if (systemProxy.hasPac) return { env: { ...input }, diagnostic: 'windows_pac_wpad_unsupported' };
    exceptions = systemProxy.enabled
      ? systemProxy.proxyOverride
          .split(';')
          .map((entry) => entry.trim())
          .filter(Boolean)
      : [];
    // WinINET hostnames are exact; NO_PROXY domains also match subdomains.
    // Only IPv4 literals and the loopback names already added below are safe.
    if (exceptions.some((entry) => isIP(entry) !== 4 && entry !== '::1' && entry.toLowerCase() !== 'localhost'))
      return { env: { ...input }, diagnostic: 'windows_proxy_override_unsupported' };
  }
  const merged = [
    ...new Map([...exceptions, 'localhost', '127.0.0.1', '::1'].map((entry) => [entry.toLowerCase(), entry])).values(),
  ];
  const env = Object.fromEntries(Object.entries(input).filter(([key]) => key.toUpperCase() !== 'NO_PROXY'));
  env.NO_PROXY = merged.join(',');
  if (platform !== 'win32') env.no_proxy = env.NO_PROXY;
  return { env, diagnostic: existing.length ? 'environment_exceptions' : 'loopback_added' };
}

/** Called after account/MCP/callback overlays, before selecting any carrier. */
export async function prepareCodexEnvironment(
  overrides: Record<string, string | null>,
  options: { workingDirectory?: string; inheritParentEnv?: boolean; bindExecutionOwner?: boolean } = {},
): Promise<Record<string, string>> {
  const base = buildChildEnv(overrides, {
    workingDirectory: options.workingDirectory,
    inheritParentEnv: options.inheritParentEnv,
    bindExecutionOwner: options.bindExecutionOwner,
  });
  // Plugin-native minimal environments do not acquire host system policy.
  if (options.inheritParentEnv === false)
    return Object.fromEntries(
      Object.entries(base).filter((entry): entry is [string, string] => entry[1] !== undefined),
    );
  const hasExceptions = Object.entries(base).some(
    ([key, value]) => key.toUpperCase() === 'NO_PROXY' && value?.split(',').some((entry) => entry.trim()),
  );
  const system = process.platform === 'win32' && !hasExceptions ? await readWindowsSystemProxy() : undefined;
  const result = deriveCodexNetworkEnvironment(base, process.platform, system);
  if (result.diagnostic.startsWith('windows_'))
    log.warn({ reason: result.diagnostic }, 'Proxy environment preserved; automatic loopback bypass unavailable');
  return Object.fromEntries(
    Object.entries(result.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
}
