import type { ToolExecutionPolicy } from '../../types.js';
import {
  captureProviderMcpConfig,
  type ProviderMcpConfigPlan,
  resolveProviderMcpConfigResolution,
} from './provider-mcp-config.js';

export type ClaudeMcpServerConfig = Record<string, unknown>;
export interface ClaudeMcpConfigResolution {
  readonly servers: Record<string, ClaudeMcpServerConfig>;
  readonly source: 'capabilities.json' | 'fallback';
}

/** Discovery is shared by all Claude carriers; credentials belong to their later launch. */
export async function captureClaudeMcpConfig(input: {
  catId: string;
  workingDirectory?: string;
  mcpServerPath?: string;
  toolExecutionPolicy?: ToolExecutionPolicy;
}) {
  if (!input.mcpServerPath || input.toolExecutionPolicy?.mode === 'read_only') return {};
  return {
    frozenNativeMcpConfig: await captureProviderMcpConfig({
      callbackEnv: { CAT_CAFE_CAT_ID: input.catId },
      workingDirectory: input.workingDirectory,
      mcpServerPath: input.mcpServerPath,
      provider: 'claude',
    }),
  };
}

/** CLI and SDK share discovery; Native consumes the same resolver's server map. */
export async function resolveClaudeMcpConfig(input: {
  readonly callbackEnv?: Record<string, string>;
  readonly workingDirectory?: string;
  readonly mcpServerPath?: string;
  readonly frozenNativeMcpConfig?: ProviderMcpConfigPlan;
}): Promise<ClaudeMcpConfigResolution | undefined> {
  if (!input.callbackEnv || !input.mcpServerPath) return undefined;
  const resolved = await resolveProviderMcpConfigResolution({
    ...input,
    callbackEnv: input.callbackEnv,
    mcpServerPath: input.mcpServerPath,
    provider: 'claude',
  });
  // Claude inherits the CLI environment into stdio children. Empty inherited Host
  // identity only; each server's explicit environment (including managed binding)
  // wins, while CLI hooks retain their original environment and credential file.
  const inheritedIdentity = Object.fromEntries(
    [
      'CAT_CAFE_CREDENTIAL_FILE',
      'CAT_CAFE_NATIVE_TURN_CREDENTIAL_FILE',
      'CAT_CAFE_NATIVE_CONNECTION_ID',
      'CAT_CAFE_INVOCATION_ID',
      'CAT_CAFE_CALLBACK_TOKEN',
      'CAT_CAFE_API_URL',
      'CAT_CAFE_DATA_DIR',
      'ALLOWED_WORKSPACE_DIRS',
    ].map((key) => [key, '']),
  );
  return {
    ...resolved,
    servers: Object.fromEntries(
      Object.entries(resolved.servers).map(([name, server]) => [
        name,
        typeof server.command === 'string'
          ? { ...server, env: { ...inheritedIdentity, ...(server.env as Record<string, string> | undefined) } }
          : server,
      ]),
    ),
  };
}
