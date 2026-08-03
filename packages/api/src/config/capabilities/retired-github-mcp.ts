import type { CapabilityEntry, McpServerDescriptor } from '@cat-cafe/shared';

const RETIRED_PACKAGE_MARKERS = [
  '@anthropic-ai/mcp-server-github',
  '@modelcontextprotocol/server-github',
  'github/github-mcp-server',
] as const;

function isRetiredGithubMcpExecutable(token: string): boolean {
  return /(^|[\\/])github-mcp-server(?:\.exe)?$/i.test(token);
}

function stringTokens(entry: Record<string, unknown>): string[] {
  const command = entry.command;
  const args = entry.args;
  const tokens: string[] = [];
  if (typeof command === 'string') tokens.push(command);
  if (Array.isArray(command)) tokens.push(...command.filter((value): value is string => typeof value === 'string'));
  if (Array.isArray(args)) tokens.push(...args.filter((value): value is string => typeof value === 'string'));
  return tokens;
}

function isRetiredGithubMcpUrl(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return url.hostname.toLowerCase() === 'api.githubcopilot.com' && /^\/mcp\/?$/i.test(url.pathname);
  } catch {
    return false;
  }
}

/**
 * Match only known GitHub MCP implementations. A user may legitimately name an
 * unrelated custom server `github`; name alone is never ownership proof.
 */
export function isRetiredGithubMcpConfigEntry(name: string, entry: unknown): boolean {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
  const record = entry as Record<string, unknown>;
  if (isRetiredGithubMcpUrl(record.url)) return true;

  const tokens = stringTokens(record).map((token) => token.toLowerCase());
  if (
    tokens.some(
      (token) =>
        isRetiredGithubMcpExecutable(token) || RETIRED_PACKAGE_MARKERS.some((marker) => token.includes(marker)),
    )
  ) {
    return true;
  }

  const normalizedName = name.toLowerCase();
  return (
    ['github', 'github-mcp', 'github-mcp-server', 'claude-github', 'codex-github'].includes(normalizedName) &&
    tokens.some((token) => token.includes('github-mcp-server') || token.includes('mcp-server-github'))
  );
}

export function isRetiredGithubMcpDescriptor(server: McpServerDescriptor): boolean {
  return isRetiredGithubMcpConfigEntry(server.name, {
    command: server.command,
    args: server.args,
    url: server.url,
  });
}

export function isRetiredGithubMcpCapability(capability: CapabilityEntry): boolean {
  if (capability.type !== 'mcp') return false;
  if (capability.pluginId?.toLowerCase() === 'github') return true;
  const server = capability.mcpServerOverride ?? capability.mcpServer;
  return isRetiredGithubMcpConfigEntry(capability.id, server);
}

export function retireGithubMcpCapabilities(config: { version: 1 | 2; capabilities: CapabilityEntry[] }): {
  migrated: boolean;
  config: typeof config;
} {
  const capabilities = config.capabilities.filter((capability) => !isRetiredGithubMcpCapability(capability));
  if (capabilities.length === config.capabilities.length) return { migrated: false, config };
  return { migrated: true, config: { ...config, capabilities } };
}
