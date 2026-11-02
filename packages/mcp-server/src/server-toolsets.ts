import { hasUsableAgentKeyCredentials } from '@cat-cafe/shared/utils';
import { McpServer, type RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { CANONICAL_TOOL_REGISTRY } from './canonical-server-tools.js';
import { derivedProfileSet, projectServerFamily } from './canonical-tool-registry.js';
import { registerCoCreatorPresentation } from './co-creator-presentation.js';
import { runWithNativeTurnAuth } from './native-turn-auth.js';
import { guardSecretToolCall } from './secret-tool-guard.js';
import type { FamilyToolDefinition, McpServerFamily } from './tool-governance-snapshot.js';
import { projectRegistrationContract } from './tool-registration-contract.js';
import { protectToolResponse } from './tool-response-budget.js';
import type { PostMessageRegistrationPrincipal } from './tools/callback-tools.js';
import {
  authorizeInvocationTool,
  getInvocationAuthSignal,
  resolveInvocationRequestSignal,
} from './tools/invocation-auth.js';

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

const KNOWN_DESKTOP_MODES = new Set(['fable-phase0', 'cloud-pro-phase0', 'live-companion']);

export interface ToolsetEnv {
  readonly?: boolean;
  hasAgentKey?: boolean;
  desktopMode?: string;
  /**
   * Explicit opt-in for the readonly+agent-key union
   * (CAT_CAFE_READONLY_AGENT_KEY_UNION=true). A read-only mount must stay
   * strictly read-only unless the launcher explicitly grants the union;
   * CAT_CAFE_AGENT_KEY_* vars inherited from a parent environment no longer
   * widen the surface on their own.
   */
  agentKeyUnion?: boolean;
  /**
   * Exact durable invocation policy projection (member MCP gateway). When
   * present, only these tool names are registered; an empty array denies every
   * tool. `undefined` means no durable policy and the profile surface applies.
   */
  allowedToolNames?: readonly string[];
}

/**
 * Parse env vars into a structured ToolsetEnv. Defaults to process.env;
 * tests may pass a fixture env to avoid module-cache games.
 */
export function parseToolsetEnv(env: NodeJS.ProcessEnv = process.env): ToolsetEnv {
  if (env.CAT_CAFE_MCP_PROFILE) throw new Error('Unknown CAT_CAFE_MCP_PROFILE');
  const desktopMode = env.CAT_CAFE_DESKTOP_MODE?.trim();
  if (
    desktopMode === 'live-companion' &&
    (!env.CAT_CAFE_NATIVE_TURN_CREDENTIAL_FILE || !env.CAT_CAFE_NATIVE_CONNECTION_ID)
  )
    throw new Error('Live companion requires native invocation binding');
  return {
    readonly: env.CAT_CAFE_READONLY === 'true',
    // Credential USABILITY, not env presence (#1494): a '{}' variant map, bad
    // JSON, a blank secret, or a path to a missing sidecar resolve zero keys
    // and must not widen the surface. Same semantics as the callback auth
    // resolution (@cat-cafe/shared/utils agent-key-credentials).
    hasAgentKey: hasUsableAgentKeyCredentials(env),
    desktopMode: desktopMode || undefined,
    agentKeyUnion: env.CAT_CAFE_READONLY_AGENT_KEY_UNION === 'true',
  };
}

/**
 * Filter a list of tools by the current ToolsetEnv.
 *
 * Precedence:
 *   1. desktopMode — NOT union with READONLY/AGENT_KEY whitelists.
 *      Unknown value → throw (fail-fast on server startup).
 *   2. !readonly → return all tools unchanged.
 *   3. readonly → READONLY_ALLOWED_TOOLS, plus AGENT_KEY_TOOLS only when the
 *      launcher explicitly opted in (agentKeyUnion) AND agent-key credentials
 *      are present (hasAgentKey). Incidental CAT_CAFE_AGENT_KEY_* vars no
 *      longer widen a read-only mount.
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
    if (env.desktopMode === 'live-companion') {
      const allowed = derivedProfileSet(CANONICAL_TOOL_REGISTRY, 'desktop:live-companion');
      return tools.filter((tool) => allowed.has(tool.name));
    }
    if (env.desktopMode === 'cloud-pro-phase0') {
      // Cloud profile derives its own bounded read/message surface from the registry.
      return tools.filter((t) => DESKTOP_CLOUD_PRO_PHASE0_ALLOWED_TOOLS.has(t.name));
    }
  }
  if (!env.readonly) return tools;
  return tools.filter(
    (t) =>
      READONLY_ALLOWED_TOOLS.has(t.name) || (!!env.agentKeyUnion && !!env.hasAgentKey && AGENT_KEY_TOOLS.has(t.name)),
  );
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

type RegisteredToolHandler = (
  args: never,
  extra: { signal: AbortSignal; _meta?: unknown },
) => Promise<{
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
  _meta?: Record<string, unknown>;
};

export function projectSchemaDeliveryMeta(definition: Pick<ToolDef, 'policy'>): Record<string, unknown> | undefined {
  return definition.policy.schemaDelivery.policy === 'always-visible' ? { 'anthropic/alwaysLoad': true } : undefined;
}

function resolvePostMessageRegistrationPrincipal(env: ToolsetEnv): PostMessageRegistrationPrincipal {
  if (process.env.CAT_CAFE_NATIVE_TURN_CREDENTIAL_FILE) return 'invocation';
  if (getInvocationAuthSignal().hasFullCredentials) return 'invocation';
  if (env.hasAgentKey) return 'agent-key';
  return 'unconfigured';
}

function registerTools(server: McpServer, tools: readonly ToolDef[], env: ToolsetEnv = parseToolsetEnv()): void {
  // Use server.registerTool(name, config, cb) — the explicit config-object API.
  // server.tool()'s overload parser uses isZodRawShapeCompat to detect whether
  // an arg is inputSchema vs annotations. Our plain JSON Schema objects fail the
  // Zod check → get mis-parsed as annotations → handler slot shifts → runtime crash.
  // registerTool() takes { description, inputSchema, annotations } explicitly, no ambiguity.
  const registerExplicit = server.registerTool.bind(server) as unknown as (
    name: string,
    config: RegisterToolConfig,
    cb: RegisteredToolHandler,
  ) => RegisteredTool;
  const principal = resolvePostMessageRegistrationPrincipal(env);
  const allowedToolNames = env.allowedToolNames ? new Set(env.allowedToolNames) : null;
  for (const tool of tools) {
    // The durable invocation policy is an exact allowlist, not a profile:
    // unregistered tools fail closed at tools/call.
    if (allowedToolNames && !allowedToolNames.has(tool.name)) continue;
    const annotations = tool.annotations;
    const deliveryMeta = projectSchemaDeliveryMeta(tool);
    const registered = registerExplicit(
      tool.name,
      {
        ...projectRegistrationContract(tool, principal),
        annotations,
        ...(deliveryMeta ? { _meta: deliveryMeta } : {}),
      },
      async (args: never, extra: { signal: AbortSignal; _meta?: unknown; requestId?: string | number }) => {
        const scopedSignal = resolveInvocationRequestSignal();
        const signal = scopedSignal ? AbortSignal.any([extra.signal, scopedSignal]) : extra.signal;
        return runWithNativeTurnAuth(extra._meta, signal, async () => {
          await authorizeInvocationTool(tool.name);
          const result = await guardSecretToolCall(
            tool.name,
            args,
            async (safeArgs) => {
              await authorizeInvocationTool(tool.name);
              signal.throwIfAborted();
              return tool.implementation.runWithExtra
                ? tool.implementation.runWithExtra(safeArgs as never, { signal })
                : tool.handler(safeArgs as never);
            },
            extra.requestId === undefined ? undefined : String(extra.requestId),
          );
          const typed = {
            ...(result as Record<string, unknown>),
          } as {
            content: Array<{ type: 'text'; text: string }>;
            isError?: boolean;
            [key: string]: unknown;
          };

          return protectToolResponse(tool.name, typed, annotations.readOnlyHint);
        });
      },
    );
    registerCoCreatorPresentation(server, tool.name, registered);
  }
}

export function registerCollabToolset(server: McpServer, env?: ToolsetEnv): void {
  const e = env ?? parseToolsetEnv();
  registerTools(server, buildCollabTools(e), e);
}

export function registerMemoryToolset(server: McpServer, env?: ToolsetEnv): void {
  const e = env ?? parseToolsetEnv();
  registerTools(server, buildMemoryTools(e), e);
}

export function registerSignalToolset(server: McpServer, env?: ToolsetEnv): void {
  const e = env ?? parseToolsetEnv();
  registerTools(server, buildSignalTools(e), e);
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

export function registerLimbToolset(server: McpServer, env?: ToolsetEnv): void {
  const e = env ?? parseToolsetEnv();
  registerTools(server, buildLimbTools(e), e);
}

export function registerAudioToolset(server: McpServer, env?: ToolsetEnv): void {
  const e = env ?? parseToolsetEnv();
  registerTools(server, buildAudioTools(e), e);
}

export function registerFinanceToolset(server: McpServer, env?: ToolsetEnv): void {
  const e = env ?? parseToolsetEnv();
  registerTools(server, buildFinanceTools(e), e);
}

export function registerFullToolset(server: McpServer, env?: ToolsetEnv): void {
  // Parse the env ONCE and thread it explicitly so a single,
  // injectable ToolsetEnv governs every family. Under CAT_CAFE_READONLY=true
  // the surface is strict (READONLY_ALLOWED_TOOLS only) unless the launcher
  // explicitly opts into the agent-key union. Tests inject fixtures here
  // instead of racing on process.env.
  const e = env ?? parseToolsetEnv();
  registerCollabToolset(server, e);
  registerMemoryToolset(server, e);
  registerSignalToolset(server, e);
  registerLimbToolset(server, e);
  registerAudioToolset(server, e);
  registerFinanceToolset(server, e);
}
