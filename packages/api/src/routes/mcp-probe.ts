/**
 * MCP Probe Helpers
 *
 * Probes an MCP server (stdio or streamableHttp) with `tools/list` and returns
 * lightweight connection + tool metadata for the Capability Center UI.
 */

import type { CapabilityEntry, McpToolInfo } from '@cat-cafe/shared';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { StdioServerParameters } from '@modelcontextprotocol/sdk/client/stdio.js';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { resolvePencilCommand } from '../config/capabilities/capability-orchestrator.js';

export interface McpProbeResult {
  connectionStatus: 'connected' | 'disconnected' | 'unknown';
  tools?: McpToolInfo[];
  /** Error detail when connectionStatus is 'disconnected'. */
  error?: string;
}

const DEFAULT_PROBE_TIMEOUT_MS = 2500;
const DEFAULT_HTTP_PROBE_TIMEOUT_MS = 8000;
const SLOW_START_PROBE_TIMEOUT_MS = 7000;
const CLOSE_TIMEOUT_MS = 300;
const MIN_STEP_TIMEOUT_MS = 100;

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Probe timeout after ${timeoutMs}ms`)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function sanitizeEnv(env: Record<string, string> | undefined): Record<string, string> | undefined {
  const safe: Record<string, string> = { ...getDefaultEnvironment() };
  if (!env) return safe;
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === 'string') safe[key] = value;
  }
  return safe;
}

/**
 * Resolve `${ENV_VAR}` references in header values from process.env.
 * Supports bare `${VAR}` as well as embedded `Bearer ${VAR}` patterns.
 */
function resolveEnvVarsInRecord(record: Record<string, string>): Record<string, string> {
  const resolved: Record<string, string> = {};
  for (const [key, value] of Object.entries(record)) {
    resolved[key] = value.replace(/\$\{([^}]+)\}/g, (_, name) => process.env[name] ?? '');
  }
  return resolved;
}

function remainingTimeout(deadlineMs: number): number {
  return Math.max(MIN_STEP_TIMEOUT_MS, deadlineMs - Date.now());
}

async function closeTransportBounded(transport: StdioClientTransport): Promise<void> {
  await Promise.race([transport.close(), new Promise<void>((resolve) => setTimeout(resolve, CLOSE_TIMEOUT_MS))]);
}

function normalizeTools(tools: Array<{ name?: string | undefined; description?: string | undefined }>): McpToolInfo[] {
  const byName = new Map<string, McpToolInfo>();
  for (const tool of tools) {
    const name = typeof tool.name === 'string' ? tool.name.trim() : '';
    if (!name) continue;
    const description = typeof tool.description === 'string' ? tool.description.trim() : undefined;
    if (!byName.has(name)) {
      byName.set(name, description ? { name, description } : { name });
    }
  }
  return [...byName.values()];
}

export function resolveProbeTimeoutMs(capability: CapabilityEntry, overrideTimeoutMs?: number): number {
  if (typeof overrideTimeoutMs === 'number' && Number.isFinite(overrideTimeoutMs) && overrideTimeoutMs > 0) {
    return overrideTimeoutMs;
  }

  const command = capability.mcpServer?.command?.toLowerCase() ?? '';
  const args = capability.mcpServer?.args ?? [];
  const argsLower = args.map((arg) => arg.toLowerCase());
  const argsJoined = argsLower.join(' ');

  // npx/pnpm-dlx based servers often need extra cold-start time.
  const isNpxLike = command === 'npx' || command === 'pnpm' || command === 'pnpmx';
  const looksLikePlaywright = argsJoined.includes('playwright');
  const isDlx = argsJoined.includes('dlx') || argsJoined.includes('-y');
  if (isNpxLike && (isDlx || looksLikePlaywright)) {
    return SLOW_START_PROBE_TIMEOUT_MS;
  }

  // Docker MCP gateway can be briefly unavailable while it reloads enabled servers.
  const isDockerGatewayRun =
    command === 'docker' && argsLower[0] === 'mcp' && argsLower[1] === 'gateway' && argsLower[2] === 'run';
  if (isDockerGatewayRun) {
    return SLOW_START_PROBE_TIMEOUT_MS;
  }

  return DEFAULT_PROBE_TIMEOUT_MS;
}

export async function probeMcpCapability(
  capability: CapabilityEntry,
  options: {
    projectRoot: string;
    timeoutMs?: number;
  },
): Promise<McpProbeResult> {
  if (capability.type !== 'mcp') return { connectionStatus: 'unknown' };
  if (!capability.mcpServer) return { connectionStatus: 'unknown' };

  const isHttp = capability.mcpServer.transport === 'streamableHttp';
  if (isHttp) return probeHttpMcp(capability, options);
  return probeStdioMcp(capability, options);
}

async function probeHttpMcp(capability: CapabilityEntry, options: { timeoutMs?: number }): Promise<McpProbeResult> {
  const url = capability.mcpServer?.url;
  if (!url) return { connectionStatus: 'unknown' };

  // #712 review P1-10: validate URL scheme to prevent SSRF via file:// / gopher:// etc.
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { connectionStatus: 'disconnected', error: 'Invalid URL' };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { connectionStatus: 'disconnected', error: `Unsupported scheme: ${parsed.protocol}` };
  }

  const timeoutMs = options.timeoutMs ?? DEFAULT_HTTP_PROBE_TIMEOUT_MS;
  const deadlineMs = Date.now() + timeoutMs;
  const requestInit: RequestInit = {};
  if (capability.mcpServer?.headers && Object.keys(capability.mcpServer.headers).length > 0) {
    requestInit.headers = resolveEnvVarsInRecord(capability.mcpServer.headers);
  }

  const transport = new StreamableHTTPClientTransport(parsed, { requestInit });
  const client = new Client({ name: 'cat-cafe-capability-probe', version: '0.1.0' }, { capabilities: {} });

  try {
    await withTimeout(client.connect(transport), remainingTimeout(deadlineMs));
    const result = await withTimeout(client.listTools(), remainingTimeout(deadlineMs));
    return {
      connectionStatus: 'connected',
      tools: normalizeTools(result.tools ?? []),
    };
  } catch (err) {
    return { connectionStatus: 'disconnected', tools: [], error: (err as Error).message };
  } finally {
    await transport.close().catch(() => {});
  }
}

async function probeStdioMcp(
  capability: CapabilityEntry,
  options: { projectRoot: string; timeoutMs?: number },
): Promise<McpProbeResult> {
  const mcp = capability.mcpServer;
  if (!mcp) return { connectionStatus: 'unknown' };
  let command = mcp.command;
  let args = mcp.args;
  if ((!command || command.trim().length === 0) && mcp.resolver === 'pencil') {
    const resolved = await resolvePencilCommand();
    if (!resolved) return { connectionStatus: 'unknown' };
    command = resolved.command;
    args = resolved.args;
  }
  if (!command || command.trim().length === 0) return { connectionStatus: 'unknown' };

  const timeoutMs = resolveProbeTimeoutMs(capability, options.timeoutMs);
  const deadlineMs = Date.now() + timeoutMs;
  const serverParams: StdioServerParameters = {
    command,
    args,
    cwd: mcp.workingDir ?? options.projectRoot,
    stderr: 'ignore',
  };
  const env = sanitizeEnv(mcp.env);
  if (env && Object.keys(env).length > 0) serverParams.env = env;

  const transport = new StdioClientTransport(serverParams);
  const client = new Client({ name: 'cat-cafe-capability-probe', version: '0.1.0' }, { capabilities: {} });

  try {
    await withTimeout(client.connect(transport), remainingTimeout(deadlineMs));
    const result = await withTimeout(client.listTools(), remainingTimeout(deadlineMs));
    return {
      connectionStatus: 'connected',
      tools: normalizeTools(result.tools ?? []),
    };
  } catch (err) {
    return { connectionStatus: 'disconnected', tools: [], error: (err as Error).message };
  } finally {
    await closeTransportBounded(transport).catch(() => {});
  }
}
