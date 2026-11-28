export const CLAUDE_MCP_STATUSES = ['connected', 'pending', 'failed', 'disabled', 'needs-auth'] as const;

export type ClaudeMcpStatus = (typeof CLAUDE_MCP_STATUSES)[number];

export interface ClaudeMcpServerStatus {
  name: string;
  status: ClaudeMcpStatus;
}

export interface ClaudeMcpStatusSnapshot {
  servers: ClaudeMcpServerStatus[];
  counts: Record<ClaudeMcpStatus, number>;
  pendingServers: string[];
  failedServers: string[];
  needsAuthServers: string[];
}

const STATUS_SET = new Set<string>(CLAUDE_MCP_STATUSES);

export function extractClaudeMcpStatusSnapshot(value: unknown): ClaudeMcpStatusSnapshot | null {
  const servers = extractClaudeMcpServers(value);

  if (servers.length === 0) return null;

  const counts: Record<ClaudeMcpStatus, number> = {
    connected: 0,
    pending: 0,
    failed: 0,
    disabled: 0,
    'needs-auth': 0,
  };
  const pendingServers: string[] = [];
  const failedServers: string[] = [];
  const needsAuthServers: string[] = [];

  for (const server of servers) {
    counts[server.status]++;
    if (server.status === 'pending') pendingServers.push(server.name);
    if (server.status === 'failed') failedServers.push(server.name);
    if (server.status === 'needs-auth') needsAuthServers.push(server.name);
  }

  return { servers, counts, pendingServers, failedServers, needsAuthServers };
}

function extractClaudeMcpServers(value: unknown): ClaudeMcpServerStatus[] {
  if (!value || typeof value !== 'object') return [];
  if (Array.isArray(value)) {
    const servers: ClaudeMcpServerStatus[] = [];
    for (const entry of value) {
      const server = normalizeClaudeMcpArrayEntry(entry);
      if (server) servers.push(server);
    }
    return servers;
  }

  const servers: ClaudeMcpServerStatus[] = [];
  for (const [name, raw] of Object.entries(value as Record<string, unknown>)) {
    const status = normalizeClaudeMcpStatus(raw);
    if (!status) continue;
    servers.push({ name, status });
  }
  return servers;
}

function normalizeClaudeMcpArrayEntry(value: unknown): ClaudeMcpServerStatus | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const entry = value as { name?: unknown; status?: unknown };
  if (typeof entry.name !== 'string' || entry.name.trim().length === 0) return null;
  const status = normalizeClaudeMcpStatus(entry.status);
  return status ? { name: entry.name, status } : null;
}

function normalizeClaudeMcpStatus(value: unknown): ClaudeMcpStatus | null {
  const status =
    typeof value === 'string'
      ? value
      : value && typeof value === 'object' && !Array.isArray(value)
        ? (value as { status?: unknown }).status
        : undefined;

  return typeof status === 'string' && STATUS_SET.has(status) ? (status as ClaudeMcpStatus) : null;
}
