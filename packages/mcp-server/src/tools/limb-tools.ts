/**
 * Limb MCP Tools — F126 四肢控制面
 *
 * limb_list_available: 列出当前在线的四肢节点及其能力
 * limb_invoke: 调用指定四肢节点的能力
 */

import { callbackPost, getCallbackConfig, NO_CONFIG_ERROR } from './callback-tools.js';
import type { ToolResult } from './file-tools.js';
import { errorResult } from './file-tools.js';

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

export const limbInvokeInputSchema = {
  type: 'object' as const,
  properties: {
    nodeId: {
      type: 'string',
      description: '目标四肢节点 ID',
    },
    command: {
      type: 'string',
      description: '要执行的命令（如 "camera.snap", "exec.run"）',
    },
    params: {
      type: 'object',
      description: '命令参数（可选）',
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

export async function handleLimbInvoke(args: {
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

// ─── Tool Definitions ────────────────────────────────────────

export const limbTools = [
  {
    name: 'limb_list_available',
    description:
      'List currently online limb nodes and their capabilities. Optionally filter by capability category. ' +
      'Limbs are external devices or plugin-backed service nodes (iPhone, Windows PC, Mac Mini, publishing services, etc.) — NOT cats. ' +
      'Use when you need to discover available node IDs, capability categories, command names, and authorization levels before invoking a device or service capability. ' +
      'Shared Antigravity MCP GOTCHA: pass agentKeyCatId to select the correct variant sidecar key.',
    inputSchema: limbListAvailableInputSchema,
    handler: handleLimbListAvailable,
  },
  {
    name: 'limb_invoke',
    description:
      'Invoke a capability on a specific limb node. Requires nodeId and command. ' +
      'Examples: limb_invoke(nodeId="iphone-1", command="camera.snap") or invoke a plugin service command listed by limb_list_available. ' +
      'GOTCHA: Get the nodeId and command from limb_list_available first — do not guess node IDs or commands. ' +
      'Shared Antigravity MCP GOTCHA: pass agentKeyCatId to select the correct variant sidecar key.',
    inputSchema: limbInvokeInputSchema,
    handler: handleLimbInvoke,
  },
  {
    name: 'limb_pair_list',
    description:
      'List pending limb pairing requests. Remote devices must be approved by co-creator before cats can use them. ' +
      'Use to check if any new devices are waiting for approval. ' +
      'Shared Antigravity MCP GOTCHA: pass agentKeyCatId to select the correct variant sidecar key.',
    inputSchema: limbPairListInputSchema,
    handler: handleLimbPairList,
  },
  {
    name: 'limb_pair_approve',
    description:
      'Approve a limb pairing request. After approval, the remote device is automatically registered in the Registry ' +
      'and becomes available for cats to invoke. ' +
      'GOTCHA: Only co-creator should initiate approval — do not auto-approve without user consent. ' +
      'Shared Antigravity MCP GOTCHA: pass agentKeyCatId to select the correct variant sidecar key.',
    inputSchema: limbPairApproveInputSchema,
    handler: handleLimbPairApprove,
  },
] as const;
