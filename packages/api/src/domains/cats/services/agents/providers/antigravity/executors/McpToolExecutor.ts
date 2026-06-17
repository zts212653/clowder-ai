import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  getDefaultEnvironment,
  StdioClientTransport,
  type StdioServerParameters,
} from '@modelcontextprotocol/sdk/client/stdio.js';
import type { TrajectoryStep } from '../AntigravityBridge.js';
import { isReadOnlyMcpTool } from '../antigravity-step-effects.js';
import type { AntigravityToolExecutor, ExecutorContext, ExecutorResult } from './AntigravityToolExecutor.js';
import { resolveToolName } from './ExecutorRegistry.js';

export interface McpToolInput {
  serverName: string;
  toolName: string;
  arguments: Record<string, unknown>;
}

type McpToolCaller = (input: McpToolInput, ctx: ExecutorContext) => Promise<unknown>;

const DEFAULT_MCP_TOOL_TIMEOUT_MS = 60_000;
const MAX_MCP_TOOL_TIMEOUT_MS = 300_000;
const MCP_TOOL_TIMEOUT_ENV = 'ANTIGRAVITY_MCP_TOOL_TIMEOUT_MS';
const CLOSE_TIMEOUT_MS = 300;

const SERVER_ENTRYPOINTS: Record<string, string> = {
  'cat-cafe': 'index.js',
  'cat-cafe-collab': 'collab.js',
  'cat-cafe-limb': 'limb.js',
  'cat-cafe-memory': 'memory.js',
  'cat-cafe-signals': 'signals.js',
  'cat-cafe-finance': 'finance.js',
};

function mcpToolTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[MCP_TOOL_TIMEOUT_ENV];
  if (!raw) return DEFAULT_MCP_TOOL_TIMEOUT_MS;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed)) return DEFAULT_MCP_TOOL_TIMEOUT_MS;
  if (parsed <= 0) return DEFAULT_MCP_TOOL_TIMEOUT_MS;
  if (parsed > MAX_MCP_TOOL_TIMEOUT_MS) return DEFAULT_MCP_TOOL_TIMEOUT_MS;
  return parsed;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise<T>((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
    timer.unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolvePromise(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

async function closeTransportBounded(transport: StdioClientTransport): Promise<void> {
  await Promise.race([
    transport.close(),
    new Promise<void>((resolveClose) => setTimeout(resolveClose, CLOSE_TIMEOUT_MS)),
  ]);
}

function stringEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === 'string') out[key] = value;
  }
  return out;
}

function findProjectRoot(cwd: string): string {
  let cursor = resolve(cwd);
  for (let i = 0; i < 8; i += 1) {
    if (existsSync(resolve(cursor, 'pnpm-workspace.yaml'))) return cursor;
    const parent = resolve(cursor, '..');
    if (parent === cursor) break;
    cursor = parent;
  }
  return resolve(cwd);
}

function uniqueNonEmpty(values: Array<string | undefined>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const trimmed = value?.trim();
    if (!trimmed) continue;
    const resolved = resolve(trimmed);
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    out.push(resolved);
  }
  return out;
}

function resolveMcpEntrypoint(
  serverName: string,
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): { entrypoint: string; projectRoot: string } | null {
  const entry = SERVER_ENTRYPOINTS[serverName.trim().toLowerCase()];
  if (!entry) return null;

  const roots = uniqueNonEmpty([env.CAT_CAFE_RUNTIME_ROOT, process.cwd(), cwd]);
  for (const root of roots) {
    const projectRoot = findProjectRoot(root);
    const candidates = [
      resolve(projectRoot, 'packages', 'mcp-server', 'dist', entry),
      resolve(root, '..', 'mcp-server', 'dist', entry),
      resolve(root, 'packages', 'mcp-server', 'dist', entry),
    ];
    for (const candidate of candidates) {
      if (existsSync(candidate)) return { entrypoint: candidate, projectRoot };
    }
  }
  return null;
}

export function resolveMcpEntrypointForTest(
  serverName: string,
  cwd: string,
  env?: NodeJS.ProcessEnv,
): { entrypoint: string; projectRoot: string } | null {
  return resolveMcpEntrypoint(serverName, cwd, env);
}

function buildMcpEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const merged = {
    ...getDefaultEnvironment(),
    ...stringEnv(env),
  };
  merged.CAT_CAFE_READONLY = 'true';
  if (!merged.CAT_CAFE_API_URL) {
    const port = merged.API_SERVER_PORT?.trim() || merged.PORT?.trim() || '3002';
    merged.CAT_CAFE_API_URL = `http://127.0.0.1:${port}`;
  }
  return merged;
}

export function buildMcpEnvForTest(env: NodeJS.ProcessEnv): Record<string, string> {
  return buildMcpEnv(env);
}

function stringifyMcpContentItem(item: unknown): string | null {
  if (!item || typeof item !== 'object') return null;
  const contentItem = item as Record<string, unknown>;
  if (contentItem.type === 'text' && typeof contentItem.text === 'string') return contentItem.text;
  if (contentItem.type === 'resource') {
    const resource = contentItem.resource;
    if (resource && typeof resource === 'object') {
      const resourceRecord = resource as Record<string, unknown>;
      if (typeof resourceRecord.text === 'string') return resourceRecord.text;
    }
  }
  const type = typeof contentItem.type === 'string' ? contentItem.type : 'unknown';
  return `[${type} content omitted]`;
}

function stringifyMcpContent(content: unknown): string | null {
  if (!Array.isArray(content)) return null;
  const parts = content.map(stringifyMcpContentItem).filter((part): part is string => part !== null);
  return parts.length > 0 ? parts.join('\n') : null;
}

function stringifyMcpResult(result: unknown): string {
  if (typeof result === 'string') return result;
  if (!result || typeof result !== 'object') return JSON.stringify(result);
  const record = result as Record<string, unknown>;
  return stringifyMcpContent(record.content) ?? JSON.stringify(result, null, 2);
}

function isErrorMcpResult(result: unknown): boolean {
  if (!result || typeof result !== 'object') return false;
  return (result as { isError?: unknown }).isError === true;
}

async function callMcpToolViaStdio(input: McpToolInput, ctx: ExecutorContext): Promise<unknown> {
  const resolved = resolveMcpEntrypoint(input.serverName, ctx.cwd);
  if (!resolved) {
    throw new Error(`Unsupported or unavailable Clowder AI MCP server: ${input.serverName}`);
  }
  const timeoutMs = mcpToolTimeoutMs();
  const serverParams: StdioServerParameters = {
    command: process.execPath,
    args: [resolved.entrypoint],
    cwd: resolved.projectRoot,
    env: buildMcpEnv(process.env),
    stderr: 'ignore',
  };
  const transport = new StdioClientTransport(serverParams);
  const client = new Client({ name: 'cat-cafe-antigravity-native-executor', version: '0.1.0' }, { capabilities: {} });
  try {
    await withTimeout(client.connect(transport), timeoutMs, `MCP connect ${input.serverName}`);
    return await withTimeout(
      client.callTool({ name: input.toolName, arguments: input.arguments }),
      timeoutMs,
      `MCP tool ${input.serverName}/${input.toolName}`,
    );
  } finally {
    await closeTransportBounded(transport).catch(() => {});
  }
}

export class CallMcpToolExecutor implements AntigravityToolExecutor<McpToolInput, unknown> {
  readonly toolName = 'call_mcp_tool';

  constructor(private readonly deps: { callTool?: McpToolCaller } = {}) {}

  canHandle(step: TrajectoryStep): boolean {
    return resolveToolName(step) === this.toolName;
  }

  async execute(input: McpToolInput, ctx: ExecutorContext): Promise<ExecutorResult<unknown>> {
    if (!isReadOnlyMcpTool(input.toolName)) {
      const refused: ExecutorResult<unknown> = {
        status: 'refused',
        reason: `MCP tool ${input.serverName}/${input.toolName} is not allowlisted read-only`,
      };
      await ctx.audit.record({
        tool: this.toolName,
        cascadeId: ctx.cascadeId,
        stepIndex: ctx.stepIndex,
        input,
        result: refused,
        timestamp: new Date(),
      });
      return refused;
    }

    const t0 = Date.now();
    try {
      const raw = await (this.deps.callTool ?? callMcpToolViaStdio)(input, ctx);
      const durationMs = Date.now() - t0;
      const stdout = stringifyMcpResult(raw);
      if (isErrorMcpResult(raw)) {
        const errorResult: ExecutorResult<unknown> = {
          status: 'error',
          error: stdout || `MCP tool ${input.serverName}/${input.toolName} returned an error`,
          durationMs,
        };
        await ctx.audit.record({
          tool: this.toolName,
          cascadeId: ctx.cascadeId,
          stepIndex: ctx.stepIndex,
          input,
          result: errorResult,
          timestamp: new Date(),
        });
        return errorResult;
      }

      const result: ExecutorResult<unknown> = {
        status: 'success',
        output: raw,
        stdout,
        durationMs,
      };
      await ctx.audit.record({
        tool: this.toolName,
        cascadeId: ctx.cascadeId,
        stepIndex: ctx.stepIndex,
        input,
        result,
        timestamp: new Date(),
      });
      return result;
    } catch (err) {
      const result: ExecutorResult<unknown> = {
        status: 'error',
        error: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - t0,
      };
      await ctx.audit.record({
        tool: this.toolName,
        cascadeId: ctx.cascadeId,
        stepIndex: ctx.stepIndex,
        input,
        result,
        timestamp: new Date(),
      });
      return result;
    }
  }
}
