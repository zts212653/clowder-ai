import { parse as parseToml } from 'smol-toml';
import { guardMcpConfig } from '../../../../../config/capabilities/secret-mcp-config.js';

/** Convert generated CLI assignments into the same config used by app-server. */
export function codexConfigObjectFromArgs(args: readonly string[]): Record<string, unknown> {
  let config: Record<string, unknown> = {};
  for (let index = 0; index < args.length; index++) {
    if (args[index] !== '--config' && args[index] !== '-c') continue;
    const assignment = args[index + 1];
    if (assignment !== undefined) {
      config = mergeCodexConfig(config, parseToml(assignment));
      index++;
    }
  }
  return config;
}

export function mergeCodexConfig(
  base: Record<string, unknown>,
  overlay: Record<string, unknown>,
): Record<string, unknown> {
  const merged = { ...base };
  for (const [key, value] of Object.entries(overlay)) {
    const previous = merged[key];
    Object.defineProperty(merged, key, {
      value: isCodexConfigObject(previous) && isCodexConfigObject(value) ? mergeCodexConfig(previous, value) : value,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return merged;
}

export function isCodexConfigObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * Codex splits override keys at every dot, including dots inside quoted names.
 * A single root value preserves the server keys without changing their identity.
 * Bare-name configurations retain their existing override form and precedence.
 */
export function codexMcpConfigArgs(args: readonly string[], callbackEnv: Record<string, string> = {}): string[] {
  return transformCodexMcpConfig(args, (server, name) => guardMcpConfig(server, callbackEnv, undefined, name));
}

/** A private plugin launch already guards its transport inside the credential-file wrapper. */
export function normalizeCodexMcpConfigArgs(args: readonly string[]): string[] {
  return transformCodexMcpConfig(args, (server) => server);
}

function transformCodexMcpConfig(
  args: readonly string[],
  transform: (server: Record<string, unknown>, name: string) => Record<string, unknown>,
): string[] {
  if (!args.some((argument) => argument.startsWith('mcp_servers'))) return [...args];
  let config: Record<string, unknown> = {};
  const retained: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const expression = args[index + 1];
    if (args[index] !== '--config' || !expression?.match(/^mcp_servers(?:\.|=)/)) {
      retained.push(args[index]);
      continue;
    }
    const overlay = parseToml(expression);
    if (!isCodexConfigObject(overlay.mcp_servers)) throw new Error('codex_mcp_config_invalid');
    // An explicit root assignment replaces the preceding table, as the CLI does.
    config = expression.startsWith('mcp_servers=') ? overlay : mergeCodexConfig(config, overlay);
    index++;
  }
  const servers = isCodexConfigObject(config.mcp_servers) ? config.mcp_servers : {};
  const guarded = Object.fromEntries(
    Object.entries(servers).map(([name, server]) => [
      name,
      isCodexConfigObject(server) ? transform(server, name) : server,
    ]),
  );
  if (
    !args.some((arg) => arg.startsWith('mcp_servers."')) &&
    Object.entries(servers).every(([name, server]) => guarded[name] === server)
  )
    return [...args];
  return [...retained, '--config', `mcp_servers=${inlineToml(guarded)}`];
}

function inlineToml(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) return String(value);
  if (Array.isArray(value)) return `[${value.map(inlineToml).join(',')}]`;
  if (isCodexConfigObject(value)) {
    return `{${Object.entries(value)
      .map(([key, entry]) => `${JSON.stringify(key)}=${inlineToml(entry)}`)
      .join(',')}}`;
  }
  throw new Error('codex_mcp_config_value_unsupported');
}
