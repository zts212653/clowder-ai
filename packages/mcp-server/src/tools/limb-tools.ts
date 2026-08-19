import { defineMcpMigrationFactory } from '../tool-governance-migration.js';

/**
 * Limb MCP Tools — F126 四肢控制面
 *
 * 3-tool workflow: discover → inspect → invoke
 *
 * limb_list_available: 发现可用 limb 及其 tool 名（无详细 schema）
 * limb_list_tools:     查询指定 limb 的 tool 详细 schema（参数/描述）
 * limb_invoke_tool:    调用 limb 上的指定 tool
 */

import { callbackPost, getCallbackConfig, NO_CONFIG_ERROR } from './callback-tools.js';
import type { ToolResult } from './file-tools.js';
import { errorResult } from './file-tools.js';

const defineTool = defineMcpMigrationFactory('limb-tools.ts', undefined, { authority: 'callback-limb' });

// ─── Input Schemas ───────────────────────────────────────────

export const limbListAvailableInputSchema = {
  type: 'object' as const,
  properties: {
    capability: {
      type: 'string',
      description: '按能力类别过滤（可选，如 "camera", "gpu_render"）',
    },
    agentKeyCatId: {
      type: 'string',
      description: '共享 Antigravity MCP 时必填你自己的 catId（如 "antig-opus"），用于选择正确的 sidecar agent key。',
    },
  },
};

export const limbListToolsInputSchema = {
  type: 'object' as const,
  properties: {
    nodeId: {
      type: 'string',
      description: '目标 limb 节点 ID（从 limb_list_available 获取）',
    },
    command: {
      type: 'string',
      description: '指定 tool 名（可选）。省略返回该 limb 全部 tool schema',
    },
    agentKeyCatId: {
      type: 'string',
      description: '共享 Antigravity MCP 时必填你自己的 catId（如 "antig-opus"），用于选择正确的 sidecar agent key。',
    },
  },
  required: ['nodeId'],
};

export const limbInvokeToolInputSchema = {
  type: 'object' as const,
  properties: {
    nodeId: {
      type: 'string',
      description: '目标 limb 节点 ID（从 limb_list_available 获取）',
    },
    command: {
      type: 'string',
      description: '要执行的 tool 名（从 limb_list_tools 获取，如 "weixin_mp.create_draft"）',
    },
    params: {
      type: 'object',
      description: 'Tool 参数（按 limb_list_tools 返回的 schema 构建）',
    },
    agentKeyCatId: {
      type: 'string',
      description: '共享 Antigravity MCP 时必填你自己的 catId（如 "antig-opus"），用于选择正确的 sidecar agent key。',
    },
  },
  required: ['nodeId', 'command'],
};

// ─── Handlers ────────────────────────────────────────────────

export async function handleLimbListAvailable(args: {
  capability?: string;
  agentKeyCatId?: string;
}): Promise<ToolResult> {
  const config = getCallbackConfig({ agentKeyCatId: args.agentKeyCatId });
  if (!config) return errorResult(NO_CONFIG_ERROR);

  const body: Record<string, unknown> = {};
  if (args.capability) body.capability = args.capability;

  return callbackPost('/api/callback/limb/list', body, { agentKeyCatId: args.agentKeyCatId });
}

export async function handleLimbListTools(args: {
  nodeId: string;
  command?: string;
  agentKeyCatId?: string;
}): Promise<ToolResult> {
  const config = getCallbackConfig({ agentKeyCatId: args.agentKeyCatId });
  if (!config) return errorResult(NO_CONFIG_ERROR);

  const body: Record<string, unknown> = { nodeId: args.nodeId };
  if (args.command) body.command = args.command;

  return callbackPost('/api/callback/limb/list-tools', body, { agentKeyCatId: args.agentKeyCatId });
}

export async function handleLimbInvokeTool(args: {
  nodeId: string;
  command: string;
  params?: Record<string, unknown>;
  agentKeyCatId?: string;
}): Promise<ToolResult> {
  const config = getCallbackConfig({ agentKeyCatId: args.agentKeyCatId });
  if (!config) return errorResult(NO_CONFIG_ERROR);

  return callbackPost(
    '/api/callback/limb/invoke',
    {
      nodeId: args.nodeId,
      command: args.command,
      params: args.params ?? {},
    },
    { agentKeyCatId: args.agentKeyCatId },
  );
}

// ─── Phase C: Pairing Tools ──────────────────────────────────

export const limbPairListInputSchema = {
  type: 'object' as const,
  properties: {
    agentKeyCatId: {
      type: 'string',
      description: '共享 Antigravity MCP 时必填你自己的 catId（如 "antig-opus"），用于选择正确的 sidecar agent key。',
    },
  },
};

export const limbPairApproveInputSchema = {
  type: 'object' as const,
  properties: {
    requestId: { type: 'string', description: '配对请求 ID' },
    agentKeyCatId: {
      type: 'string',
      description: '共享 Antigravity MCP 时必填你自己的 catId（如 "antig-opus"），用于选择正确的 sidecar agent key。',
    },
  },
  required: ['requestId'],
};

export async function handleLimbPairList(args: { agentKeyCatId?: string } = {}): Promise<ToolResult> {
  const config = getCallbackConfig({ agentKeyCatId: args.agentKeyCatId });
  if (!config) return errorResult(NO_CONFIG_ERROR);
  return callbackPost('/api/callback/limb/pair/list', {}, { agentKeyCatId: args.agentKeyCatId });
}

export async function handleLimbPairApprove(args: { requestId: string; agentKeyCatId?: string }): Promise<ToolResult> {
  const config = getCallbackConfig({ agentKeyCatId: args.agentKeyCatId });
  if (!config) return errorResult(NO_CONFIG_ERROR);
  return callbackPost(
    '/api/callback/limb/pair/approve',
    { requestId: args.requestId },
    {
      agentKeyCatId: args.agentKeyCatId,
    },
  );
}

// ─── F285: Physical embodiment binding ───────────────────────

export const limbBindEmbodimentInputSchema = {
  type: 'object' as const,
  properties: {
    nodeId: { type: 'string', description: '已审批且在线的物理 limb nodeId' },
    expressionRef: { type: 'string', description: '当前猫已登记的表情映射引用' },
    voiceProfileRef: { type: 'string', description: '当前猫已登记的声线映射引用' },
    volumePercent: { type: 'number', minimum: 0, maximum: 100, description: '扬声器音量百分比' },
    agentKeyCatId: {
      type: 'string',
      description: '共享 Antigravity MCP 时必填你自己的 catId，用于选择正确的 sidecar agent key。',
    },
  },
  required: ['nodeId', 'expressionRef', 'voiceProfileRef', 'volumePercent'],
};

export async function handleLimbBindEmbodiment(args: {
  nodeId: string;
  expressionRef: string;
  voiceProfileRef: string;
  volumePercent: number;
  agentKeyCatId?: string;
}): Promise<ToolResult> {
  const config = getCallbackConfig({ agentKeyCatId: args.agentKeyCatId });
  if (!config) return errorResult(NO_CONFIG_ERROR);
  return callbackPost(
    '/api/callback/limb/embodiment/bind',
    {
      nodeId: args.nodeId,
      expressionRef: args.expressionRef,
      voiceProfileRef: args.voiceProfileRef,
      volumePercent: args.volumePercent,
    },
    { agentKeyCatId: args.agentKeyCatId },
  );
}

// ─── Tool Definitions ────────────────────────────────────────

export const limbTools = [
  defineTool({
    name: 'limb_list_available',
    description:
      'Discover available limb nodes and their tool names. Returns nodeId, platform, capabilities (with command names), and status. ' +
      'Limbs are external devices or plugin-backed service endpoints (iPhone, WeChat MP, Xiaohongshu, Mac Mini, etc.) — NOT cats. ' +
      'Step 1 of 3: list_available → list_tools → invoke_tool. ' +
      'Returns tool names but NOT detailed parameter schemas — call limb_list_tools next to get schemas. ' +
      'Shared Antigravity MCP GOTCHA: pass agentKeyCatId to select the correct variant sidecar key.',
    inputSchema: limbListAvailableInputSchema,
    handler: handleLimbListAvailable,
    governance: {
      implementationExport: 'handleLimbListAvailable',
      resourceFamily: 'limb-capability',
      action: 'read',
      risk: { level: 'read', openWorld: false },
      runtimeProfiles: ['full', 'readonly'],
      targetExposure: 'lazy-discoverable',
    },
  }),
  defineTool({
    name: 'limb_list_tools',
    description:
      'Get detailed tool schemas for a specific limb node. Returns parameter descriptions, types, required flags, and defaults. ' +
      'Step 2 of 3: list_available → list_tools → invoke_tool. ' +
      'Pass nodeId (from limb_list_available) and optionally a specific command name. ' +
      'Without command: returns all tool schemas for the node. With command: returns schema for that specific tool only. ' +
      'Use the returned schema to construct the correct params for limb_invoke_tool. ' +
      'Shared Antigravity MCP GOTCHA: pass agentKeyCatId to select the correct variant sidecar key.',
    inputSchema: limbListToolsInputSchema,
    handler: handleLimbListTools,
    governance: {
      implementationExport: 'handleLimbListTools',
      resourceFamily: 'limb-capability',
      action: 'read',
      risk: { level: 'read', openWorld: false },
      runtimeProfiles: ['full', 'readonly'],
      targetExposure: 'lazy-discoverable',
    },
  }),
  defineTool({
    name: 'limb_invoke_tool',
    description:
      'Invoke a tool on a specific limb node. Requires nodeId and command (tool name). ' +
      'Step 3 of 3: list_available → list_tools → invoke_tool. ' +
      'Examples: limb_invoke_tool(nodeId="weixin-mp", command="weixin_mp.create_draft", params={...}). ' +
      'GOTCHA: Get nodeId from limb_list_available and build params according to limb_list_tools schema — do not guess. ' +
      'Shared Antigravity MCP GOTCHA: pass agentKeyCatId to select the correct variant sidecar key.',
    inputSchema: limbInvokeToolInputSchema,
    handler: handleLimbInvokeTool,
    governance: {
      implementationExport: 'handleLimbInvokeTool',
      resourceFamily: 'limb-capability',
      action: 'create',
      risk: { level: 'destructive', openWorld: true },
      runtimeProfiles: ['full', 'readonly'],
      targetExposure: 'profile-gated',
    },
  }),
  defineTool({
    name: 'limb_pair_list',
    description:
      'List pending limb pairing requests. Remote devices must be approved by co-creator before cats can use them. ' +
      'Use to check if any new devices are waiting for approval. ' +
      'Shared Antigravity MCP GOTCHA: pass agentKeyCatId to select the correct variant sidecar key.',
    inputSchema: limbPairListInputSchema,
    handler: handleLimbPairList,
    governance: {
      implementationExport: 'handleLimbPairList',
      resourceFamily: 'limb-pairing',
      action: 'command',
      risk: { level: 'read', openWorld: false },
      runtimeProfiles: ['full', 'readonly'],
      targetExposure: 'lazy-discoverable',
    },
  }),
  defineTool({
    name: 'limb_pair_approve',
    description:
      'Approve a limb pairing request. After approval, the remote device is automatically registered in the Registry ' +
      'and becomes available for cats to invoke. ' +
      'GOTCHA: Only co-creator should initiate approval — do not auto-approve without user consent. ' +
      'Shared Antigravity MCP GOTCHA: pass agentKeyCatId to select the correct variant sidecar key.',
    inputSchema: limbPairApproveInputSchema,
    handler: handleLimbPairApprove,
    governance: {
      implementationExport: 'handleLimbPairApprove',
      resourceFamily: 'limb-pairing',
      action: 'create',
      risk: { level: 'write', openWorld: false },
      runtimeProfiles: ['full', 'readonly'],
      targetExposure: 'lazy-discoverable',
    },
  }),
  defineTool({
    name: 'limb_bind_embodiment',
    description:
      'Bind one approved, online physical limb body to the current user, thread, and cat. ' +
      'The server derives identity from callback credentials; callers cannot provide userId/threadId/catId. ' +
      'GOTCHA: Only run after the owner explicitly asks to embody the current cat on that node.',
    inputSchema: limbBindEmbodimentInputSchema,
    handler: handleLimbBindEmbodiment,
    governance: {
      implementationExport: 'handleLimbBindEmbodiment',
      resourceFamily: 'limb-embodiment',
      action: 'update',
      risk: { level: 'write', openWorld: false },
      runtimeProfiles: ['full', 'readonly'],
      targetExposure: 'lazy-discoverable',
    },
  }),
] as const;
