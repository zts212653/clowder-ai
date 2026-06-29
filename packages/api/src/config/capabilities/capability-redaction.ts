import type { CapabilityAuditEntry, CapabilityEntry, McpInstallPreview } from '@cat-cafe/shared';

export const REDACTED_CAPABILITY_SECRET = '••••••';

function redactRecord(record: Record<string, string> | undefined): Record<string, string> | undefined {
  if (!record) return undefined;
  return Object.fromEntries(Object.keys(record).map((key) => [key, REDACTED_CAPABILITY_SECRET]));
}

export function sanitizeCapabilityForAudit(entry: CapabilityEntry | null): CapabilityEntry | null {
  if (!entry) return null;
  const sanitized: CapabilityEntry = { ...entry };
  if (!entry.mcpServer) return sanitized;

  const mcpServer: NonNullable<CapabilityEntry['mcpServer']> = { ...entry.mcpServer };
  if (Array.isArray(entry.mcpServer.args)) {
    mcpServer.args = [...entry.mcpServer.args];
  }
  const redactedEnv = redactRecord(entry.mcpServer.env);
  const redactedHeaders = redactRecord(entry.mcpServer.headers);
  if (redactedEnv) mcpServer.env = redactedEnv;
  else delete mcpServer.env;
  if (redactedHeaders) mcpServer.headers = redactedHeaders;
  else delete mcpServer.headers;
  sanitized.mcpServer = mcpServer;
  return sanitized;
}

/**
 * Client-side app: return real values for editing — no need to mask from the local user.
 * Frontend handles display masking via password inputs + eye toggle.
 * Audit logs continue using sanitizeCapabilityForAudit (always redacted).
 */
export function sanitizeCapabilityForResponse(entry: CapabilityEntry | null): CapabilityEntry | null {
  return entry;
}

export function sanitizeCapabilityAuditEntry(entry: CapabilityAuditEntry): CapabilityAuditEntry {
  return {
    ...entry,
    before: sanitizeCapabilityForAudit(entry.before),
    after: sanitizeCapabilityForAudit(entry.after),
  };
}

export function sanitizeMcpInstallPreviewForResponse(preview: McpInstallPreview): McpInstallPreview {
  return {
    ...preview,
    entry: sanitizeCapabilityForResponse(preview.entry) ?? preview.entry,
  };
}
