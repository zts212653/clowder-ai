import type { CapabilityEntry, McpInstallPreview, McpInstallRequest } from '@cat-cafe/shared';

const CLI_CONFIGS = ['.mcp.json', '.codex/config.toml', '.gemini/settings.json', '.kimi/mcp.json'];

export function buildInstallPreview(req: McpInstallRequest, existingCaps?: CapabilityEntry[]): McpInstallPreview {
  if (!req.id || typeof req.id !== 'string') {
    throw new Error('id must be a non-empty string');
  }
  if (req.args !== undefined && (!Array.isArray(req.args) || !req.args.every((a) => typeof a === 'string'))) {
    throw new Error('args must be an array of strings');
  }
  if (req.env !== undefined && (typeof req.env !== 'object' || req.env === null || Array.isArray(req.env))) {
    throw new Error('env must be a Record<string, string>');
  }
  if (
    req.headers !== undefined &&
    (typeof req.headers !== 'object' || req.headers === null || Array.isArray(req.headers))
  ) {
    throw new Error('headers must be a Record<string, string>');
  }
  if (req.url !== undefined && typeof req.url !== 'string') {
    throw new Error('url must be a string');
  }
  if (req.resolver !== undefined && typeof req.resolver !== 'string') {
    throw new Error('resolver must be a string');
  }
  const hasResolver = !!req.resolver;
  const entry: CapabilityEntry = {
    id: req.id,
    type: 'mcp',
    enabled: true,
    source: 'external',
    mcpServer: {
      transport: req.transport ?? 'stdio',
      command: req.command ?? '',
      args: req.args ?? [],
      ...(req.url && { url: req.url }),
      ...(req.headers && { headers: req.headers }),
      ...(req.env && { env: req.env }),
      ...(hasResolver && { resolver: req.resolver }),
    },
  };

  const willProbe = entry.mcpServer?.transport !== 'streamableHttp' && !hasResolver && !!(req.command || req.url);

  const risks: string[] = [];
  if (existingCaps?.some((c) => c.id === req.id && c.type === 'mcp')) {
    risks.push(`MCP "${req.id}" already exists — install will overwrite`);
  }
  if (!req.command && !req.resolver && !req.url) {
    risks.push('No command, resolver, or URL — MCP will be unresolvable');
  }

  return { entry, cliConfigsAffected: CLI_CONFIGS, willProbe, risks };
}
