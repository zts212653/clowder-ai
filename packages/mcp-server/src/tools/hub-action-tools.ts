import { z } from 'zod';
import { callbackPost, getCallbackConfig } from './callback-tools.js';
import type { ToolResult } from './file-tools.js';
import { errorResult } from './file-tools.js';

const optionalContextSchemas = {
  threadId: z
    .string()
    .min(1)
    .optional()
    .describe('Current Clowder AI thread id; pass when available to avoid tab leakage.'),
  worktreeId: z
    .string()
    .min(1)
    .optional()
    .describe('Target Clowder AI worktree id; pass when the action is worktree-scoped.'),
  catId: z.string().min(1).optional().describe('Calling cat id for audit/probe correlation.'),
  agentKeyCatId: z
    .string()
    .min(1)
    .optional()
    .describe(
      'Persistent-agent identity selector. Required for shared Antigravity MCP when CAT_CAFE_AGENT_KEY_FILES is configured; ignored when invocation credentials are present.',
    ),
};

export const workspaceNavigateInputSchema = {
  path: z
    .string()
    .min(1)
    .describe('Codex-native absolute local path, or a repo-relative file/directory path when worktreeId is provided.'),
  action: z
    .enum(['reveal', 'open'])
    .optional()
    .describe(
      'Workspace navigation action. Use reveal for directories/uncertain targets; open for files. Default: reveal.',
    ),
  worktreeId: z
    .string()
    .min(1)
    .optional()
    .describe('Target worktree id for repo-relative paths; omit when path is absolute.'),
  line: z.number().int().min(1).optional().describe('Optional 1-based line number for action=open.'),
  threadId: z
    .string()
    .min(1)
    .optional()
    .describe(
      'Authenticated Clowder AI thread scope. Required for agent-key auth because persistent MCP has no invocation thread; omit for invocation auth to use its bound thread.',
    ),
  catId: optionalContextSchemas.catId,
  agentKeyCatId: optionalContextSchemas.agentKeyCatId,
};

export const previewOpenInputSchema = {
  port: z.number().int().min(1).max(65535).describe('Localhost port to open in Hub Browser Preview.'),
  path: z.string().min(1).optional().describe('Path on the localhost app to open. Default: /.'),
  worktreeId: optionalContextSchemas.worktreeId,
  threadId: optionalContextSchemas.threadId,
  catId: optionalContextSchemas.catId,
  agentKeyCatId: optionalContextSchemas.agentKeyCatId,
};

function resolveWorkspaceNavigateAuthMode(agentKeyCatId: string | undefined): 'agent-key' | 'invocation-or-none' {
  const config = getCallbackConfig({ agentKeyCatId });
  const hasInvocationAuth = Boolean(config?.invocationId && config.callbackToken);
  if (!hasInvocationAuth && config?.agentKeySecret) return 'agent-key';
  return 'invocation-or-none';
}

export async function handleWorkspaceNavigate(input: {
  path: string;
  action?: 'reveal' | 'open';
  worktreeId?: string | undefined;
  line?: number | undefined;
  threadId?: string | undefined;
  catId?: string | undefined;
  agentKeyCatId?: string | undefined;
}): Promise<ToolResult> {
  if (resolveWorkspaceNavigateAuthMode(input.agentKeyCatId) === 'agent-key' && !input.threadId) {
    return errorResult(
      'threadId is required for agent-key Workspace navigation. ' +
        'Persistent agent-key MCP has no invocation thread, so the API cannot verify the target thread scope implicitly.',
    );
  }

  return callbackPost(
    '/api/workspace/navigate',
    {
      path: input.path,
      action: input.action ?? 'reveal',
      ...(input.worktreeId ? { worktreeId: input.worktreeId } : {}),
      ...(input.line !== undefined ? { line: input.line } : {}),
      ...(input.threadId ? { threadId: input.threadId } : {}),
      ...(input.catId ? { catId: input.catId } : {}),
    },
    { agentKeyCatId: input.agentKeyCatId },
  );
}

export async function handlePreviewOpen(input: {
  port: number;
  path?: string | undefined;
  worktreeId?: string | undefined;
  threadId?: string | undefined;
  catId?: string | undefined;
  agentKeyCatId?: string | undefined;
}): Promise<ToolResult> {
  return callbackPost(
    '/api/preview/auto-open',
    {
      port: input.port,
      path: input.path ?? '/',
      ...(input.worktreeId ? { worktreeId: input.worktreeId } : {}),
      ...(input.threadId ? { threadId: input.threadId } : {}),
      ...(input.catId ? { catId: input.catId } : {}),
    },
    { agentKeyCatId: input.agentKeyCatId },
  );
}

export const hubActionTools = [
  {
    name: 'cat_cafe_workspace_navigate',
    description:
      'Open or reveal an absolute local path or typed repo-relative path in the Hub Workspace panel. ' +
      'Use when: the user asks to open a local file, inspect logs/docs/code, or see a newly created artifact. ' +
      'NOT for: HTTP links or localhost apps (use normal links or cat_cafe_preview_open). ' +
      'Output: the accepted request plus deliveryStatus=applied|queued|blocked|unconfirmed and an audit probe. ' +
      'GOTCHA: ok:true means the request was accepted, not that the file is visible; only applied proves a connected Hub client changed Workspace state. ' +
      'Absolute paths need no worktreeId; repo-relative paths require one. threadId is required for agent-key auth and may be omitted for invocation auth. ' +
      'Shared persistent MCP callers pass agentKeyCatId; do not handwrite curl to /api/workspace/navigate.',
    inputSchema: workspaceNavigateInputSchema,
    handler: handleWorkspaceNavigate,
  },
  {
    name: 'cat_cafe_preview_open',
    description:
      'Open a localhost app in the Hub Browser Preview panel. ' +
      'Use after starting or discovering a dev server, or when the user asks to see frontend changes. ' +
      'Result: the Hub Browser panel auto-opens the localhost target through the preview gateway. ' +
      'GOTCHA: validate the target dev server first; shared persistent MCP callers pass agentKeyCatId; do not handwrite curl to /api/preview/auto-open.',
    inputSchema: previewOpenInputSchema,
    handler: handlePreviewOpen,
  },
] as const;
