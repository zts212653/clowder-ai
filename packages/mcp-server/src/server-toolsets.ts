import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { CANONICAL_TOOL_REGISTRY } from './canonical-server-tools.js';
import { derivedProfileSet, projectServerFamily } from './canonical-tool-registry.js';
import { jsonSchemaToZod } from './json-schema-to-zod.js';
import type { FamilyToolDefinition, McpServerFamily } from './tool-governance-snapshot.js';
import { callbackPost, getCallbackConfig } from './tools/callback-tools.js';

export { CANONICAL_TOOL_REGISTRY } from './canonical-server-tools.js';

type ToolDef = FamilyToolDefinition;

/** Compatibility exports. Their contents are projections, never independent allowlists. */
export const READONLY_ALLOWED_TOOLS = derivedProfileSet(CANONICAL_TOOL_REGISTRY, 'readonly');
export const AGENT_KEY_TOOLS = derivedProfileSet(CANONICAL_TOOL_REGISTRY, 'agent-key');
export const DESKTOP_FABLE_PHASE0_ALLOWED_TOOLS = derivedProfileSet(CANONICAL_TOOL_REGISTRY, 'desktop:fable-phase0');
export const DESKTOP_CLOUD_PRO_PHASE0_ALLOWED_TOOLS = derivedProfileSet(
  CANONICAL_TOOL_REGISTRY,
  'desktop:cloud-pro-phase0',
);

const KNOWN_DESKTOP_MODES = new Set(['fable-phase0', 'cloud-pro-phase0']);

export interface ToolsetEnv {
  readonly?: boolean;
  hasAgentKey?: boolean;
  desktopMode?: string;
}

/**
 * Parse env vars into a structured ToolsetEnv. Defaults to process.env;
 * tests may pass a fixture env to avoid module-cache games.
 */
export function parseToolsetEnv(env: NodeJS.ProcessEnv = process.env): ToolsetEnv {
  const desktopMode = env.CAT_CAFE_DESKTOP_MODE?.trim();
  return {
    readonly: env.CAT_CAFE_READONLY === 'true',
    hasAgentKey: !!(env.CAT_CAFE_AGENT_KEY_SECRET || env.CAT_CAFE_AGENT_KEY_FILE || env.CAT_CAFE_AGENT_KEY_FILES),
    desktopMode: desktopMode || undefined,
  };
}

/**
 * Filter a list of tools by the current ToolsetEnv.
 *
 * Precedence (V3, codex APPROVE):
 *   1. desktopMode highest — NOT union with READONLY/AGENT_KEY whitelists.
 *      Unknown value → throw (fail-fast on server startup).
 *   2. !readonly → return all tools unchanged.
 *   3. readonly → READONLY_ALLOWED_TOOLS ∪ (hasAgentKey ? AGENT_KEY_TOOLS : ∅).
 */
export function applyReadonlyFilter<T extends { name: string }>(
  tools: readonly T[],
  env: ToolsetEnv = parseToolsetEnv(),
): readonly T[] {
  if (env.desktopMode) {
    if (!KNOWN_DESKTOP_MODES.has(env.desktopMode)) {
      throw new Error(
        `Unknown CAT_CAFE_DESKTOP_MODE: "${env.desktopMode}". Valid modes: ${[...KNOWN_DESKTOP_MODES].join(', ')}`,
      );
    }
    if (env.desktopMode === 'fable-phase0') {
      return tools.filter((t) => DESKTOP_FABLE_PHASE0_ALLOWED_TOOLS.has(t.name));
    }
    if (env.desktopMode === 'cloud-pro-phase0') {
      // F238 Phase B1a + F231: cloud-pro-phase0 复用 fable-phase0 同 11 工具白名单
      return tools.filter((t) => DESKTOP_CLOUD_PRO_PHASE0_ALLOWED_TOOLS.has(t.name));
    }
  }
  if (!env.readonly) return tools;
  return tools.filter((t) => READONLY_ALLOWED_TOOLS.has(t.name) || (!!env.hasAgentKey && AGENT_KEY_TOOLS.has(t.name)));
}

function buildFamilyTools(serverFamily: McpServerFamily, env?: ToolsetEnv): readonly ToolDef[] {
  return projectServerFamily(CANONICAL_TOOL_REGISTRY, serverFamily, env ?? parseToolsetEnv());
}

export function buildCollabTools(env?: ToolsetEnv): readonly ToolDef[] {
  return buildFamilyTools('collab', env);
}

export function buildMemoryTools(env?: ToolsetEnv): readonly ToolDef[] {
  return buildFamilyTools('memory', env);
}

export function buildSignalTools(env?: ToolsetEnv): readonly ToolDef[] {
  return buildFamilyTools('signals', env);
}

export function buildFinanceTools(env?: ToolsetEnv): readonly ToolDef[] {
  return buildFamilyTools('finance', env);
}

export function buildAudioTools(env?: ToolsetEnv): readonly ToolDef[] {
  return buildFamilyTools('audio', env);
}

/** Compatibility name retained for consumers; values derive from each operation's maximum risk. */
export const EXPLICIT_TOOL_ANNOTATIONS: Readonly<Record<string, ToolDef['annotations']>> = Object.fromEntries(
  CANONICAL_TOOL_REGISTRY.map((definition) => [definition.name, definition.annotations]),
);

type RegisteredToolHandler = (args: never) => Promise<{
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
  [key: string]: unknown;
}>;

/**
 * Type-erased registerTool config. SDK 1.26.0 requires Zod schemas for:
 *   - Tool listing: normalizeObjectSchema() reads .shape for JSON Schema serialization
 *   - Tool calls: safeParseAsync() validates incoming arguments
 *
 * Our tool definitions use plain JSON Schema objects, so jsonSchemaToZod()
 * converts them to Zod v3 at registration time.
 * server.registerTool(name, config, cb) bypasses the overload parser entirely.
 */
type RegisterToolConfig = {
  description: string;
  inputSchema: z.ZodObject<z.ZodRawShape>;
  annotations: {
    readOnlyHint: boolean;
    destructiveHint: boolean;
    openWorldHint: boolean;
  };
};

// ── F254 Phase B1: In-memory freshness notice state (per MCP server process = per invocation) ──
const freshnessNoticeState = { toolCallCount: 0, noticeDeliveredCount: 0, lastNoticeToolCallNum: 0 };
const FRESHNESS_NOTICE_INTERVAL = 5;
const FRESHNESS_MAX_NOTICES = 3;

/**
 * F254 B1: Check if a freshness notice should be piggybacked on this tool result.
 * Frequency-gated in-memory (every 5 read-only calls, max 3 per invocation).
 * Only calls the API when the gate passes — minimizes HTTP overhead.
 */
async function maybeFreshnessNotice(toolName: string, isReadOnly: boolean): Promise<string | null> {
  freshnessNoticeState.toolCallCount++;

  if (!isReadOnly) return null;
  if (freshnessNoticeState.noticeDeliveredCount >= FRESHNESS_MAX_NOTICES) return null;
  if (freshnessNoticeState.toolCallCount - freshnessNoticeState.lastNoticeToolCallNum < FRESHNESS_NOTICE_INTERVAL) {
    return null;
  }

  // Gate passed — call API to check for unseen messages
  if (!getCallbackConfig()) return null;

  try {
    const result = await callbackPost('/api/callbacks/freshness-notice-check', {
      toolName,
      isReadOnly: true,
    });
    if (result.isError) return null;

    const data = JSON.parse((result.content[0] as { text: string }).text);
    // Advance interval counter after ANY API call, not just successful delivery.
    // Otherwise quiet threads (no unseen) bypass the interval gate on every call.
    // (Cloud review R2 P2-R2-2)
    freshnessNoticeState.lastNoticeToolCallNum = freshnessNoticeState.toolCallCount;
    if (data?.notice?.text) {
      freshnessNoticeState.noticeDeliveredCount++;
      return data.notice.text;
    }
  } catch {
    // Fail-open: notice errors never block tool execution
  }
  return null;
}

function registerTools(server: McpServer, tools: readonly ToolDef[]): void {
  // Use server.registerTool(name, config, cb) — the explicit config-object API.
  // server.tool()'s overload parser uses isZodRawShapeCompat to detect whether
  // an arg is inputSchema vs annotations. Our plain JSON Schema objects fail the
  // Zod check → get mis-parsed as annotations → handler slot shifts → runtime crash.
  // registerTool() takes { description, inputSchema, annotations } explicitly, no ambiguity.
  const registerExplicit = server.registerTool.bind(server) as unknown as (
    name: string,
    config: RegisterToolConfig,
    cb: RegisteredToolHandler,
  ) => void;
  for (const tool of tools) {
    const annotations = tool.annotations;
    // Distinguish Zod raw shape (callback tools) from plain JSON Schema (limb tools).
    // Zod raw shapes have Zod instances as values; JSON Schema has type/properties keys.
    const schema = tool.inputSchema;
    const zodSchema =
      typeof schema.type === 'string' && typeof schema.properties === 'object' && schema.properties !== null
        ? jsonSchemaToZod(schema)
        : z.object(schema as z.ZodRawShape);
    registerExplicit(
      tool.name,
      { description: tool.description, inputSchema: zodSchema, annotations },
      async (args: never) => {
        const result = await tool.handler(args);
        const typed = {
          ...(result as Record<string, unknown>),
        } as {
          content: Array<{ type: 'text'; text: string }>;
          isError?: boolean;
          [key: string]: unknown;
        };

        // F254 B1: Piggyback freshness notice on successful read-only tool results
        if (!typed.isError && annotations.readOnlyHint) {
          const noticeText = await maybeFreshnessNotice(tool.name, annotations.readOnlyHint);
          if (noticeText) {
            typed.content = [...typed.content, { type: 'text', text: `\n\n${noticeText}` }];
          }
        }

        return typed;
      },
    );
  }
}

export function registerCollabToolset(server: McpServer): void {
  registerTools(server, buildCollabTools());
}

export function registerMemoryToolset(server: McpServer): void {
  registerTools(server, buildMemoryTools());
}

export function registerSignalToolset(server: McpServer): void {
  registerTools(server, buildSignalTools());
}

// F061: limbTools 默认不走 readonly filter（Antigravity 设计要求 — 让 antigravity
// readonly + agent-key 仍能调 limb 控制 antigravity 自己的浏览器）。
//
// 但 F178 Phase D V3（cloud codex review 2026-06-13 P1）：DESKTOP_MODE=fable-phase0
// 是 strict-whitelist 模式 + 最高优先级，在 legacy createServer + registerFullToolset
// 路径下（fable Desktop config 误指 dist/index.js）必须杜绝 limb_invoke_tool /
// limb_pair_approve 等设备控制面暴露。defense-in-depth：DESKTOP_FABLE_PHASE0_ALLOWED_TOOLS
// 不含任何 limb 工具，所以 fable-phase0 mode 下 limb 全 deny。
export function buildLimbTools(env?: ToolsetEnv): readonly ToolDef[] {
  const e = env ?? parseToolsetEnv();
  // F178 Phase D cloud-review round 3 P2: any non-empty desktopMode (even
  // a mistyped one) must go through applyReadonlyFilter so unknown modes
  // throw fail-fast on server startup instead of silently registering the
  // full limb surface in standalone limb.ts entry. Antigravity / default
  // (no desktopMode set) keeps the F061 contract: limb fully exposed,
  // not filtered by readonly.
  if (e.desktopMode) {
    return buildFamilyTools('limb', e);
  }
  return CANONICAL_TOOL_REGISTRY.filter((definition) => definition.serverFamily === 'limb');
}

export function registerLimbToolset(server: McpServer): void {
  registerTools(server, buildLimbTools());
}

export function registerAudioToolset(server: McpServer): void {
  registerTools(server, buildAudioTools());
}

export function registerFinanceToolset(server: McpServer): void {
  registerTools(server, buildFinanceTools());
}

export function registerFullToolset(server: McpServer): void {
  registerCollabToolset(server);
  registerMemoryToolset(server);
  registerSignalToolset(server);
  registerLimbToolset(server);
  registerAudioToolset(server);
  registerFinanceToolset(server);
}
