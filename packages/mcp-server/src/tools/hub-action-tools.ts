import { z } from 'zod';
import { callbackPost } from './callback-tools.js';
import type { ToolResult } from './file-tools.js';

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
  path: z.string().min(1).describe('Repo-relative file or directory path to reveal/open in the Hub Workspace panel.'),
  action: z
    .enum(['reveal', 'open'])
    .optional()
    .describe(
      'Workspace navigation action. Use reveal for directories/uncertain targets; open for files. Default: reveal.',
    ),
  worktreeId: z.string().min(1).describe('Target worktree id, e.g. cat-cafe or cat-cafe-runtime.'),
  line: z.number().int().min(1).optional().describe('Optional 1-based line number for action=open.'),
  threadId: optionalContextSchemas.threadId,
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

export async function handleWorkspaceNavigate(input: {
  path: string;
  action?: 'reveal' | 'open';
  worktreeId: string;
  line?: number | undefined;
  threadId?: string | undefined;
  catId?: string | undefined;
  agentKeyCatId?: string | undefined;
}): Promise<ToolResult> {
  return callbackPost(
    '/api/workspace/navigate',
    {
      path: input.path,
      action: input.action ?? 'reveal',
      worktreeId: input.worktreeId,
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
      'Open or reveal a repo-relative file/directory in the Hub Workspace panel. ' +
      'Use when the user asks to open a file, inspect logs/docs/code, or when you created an artifact that should be visible. ' +
      'Result: the Hub emits workspace navigation scoped by worktree/thread and records audit probes. ' +
      'GOTCHA: pass repo-relative paths and a target worktreeId; shared persistent MCP callers pass agentKeyCatId; do not handwrite curl to /api/workspace/navigate.',
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
