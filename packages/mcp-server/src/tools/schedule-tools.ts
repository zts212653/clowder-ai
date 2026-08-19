import { defineMcpMigrationFactory } from '../tool-governance-migration.js';

/**
 * F139 Phase 3A: Schedule MCP Tools (AC-G2)
 *
 * cat_cafe_list_schedule_templates  — list available task templates
 * cat_cafe_register_scheduled_task  — create a dynamic scheduled task from template
 * cat_cafe_remove_scheduled_task    — propose permanent deletion of a dynamic scheduled task
 */

import { z } from 'zod';
import { callbackGet, callbackPost, getCallbackConfig } from './callback-tools.js';
import type { ToolResult } from './file-tools.js';
import { errorResult } from './file-tools.js';

const defineTool = defineMcpMigrationFactory('schedule-tools.ts', undefined, {
  resourceFamily: 'schedule',
  authority: 'callback-owner',
});

const agentKeyCatIdSchema = z
  .string()
  .min(1)
  .optional()
  .describe(
    'Persistent-agent identity selector. Required for shared Antigravity MCP when CAT_CAFE_AGENT_KEY_FILES is configured; ignored when invocation credentials are present.',
  );

function resolveScheduleMcpAuthMode(agentKeyCatId: string | undefined): 'agent-key' | 'invocation-or-none' {
  const config = getCallbackConfig({ agentKeyCatId });
  const hasInvocationAuth = Boolean(config?.invocationId && config.callbackToken);
  if (!hasInvocationAuth && config?.agentKeySecret) return 'agent-key';
  return 'invocation-or-none';
}

// ─── callbackDelete (schedule-specific) ──────────────────────

async function callbackDelete(path: string, options?: { agentKeyCatId?: string }): Promise<ToolResult> {
  const { getCallbackConfig, buildAuthHeaders, NO_CONFIG_ERROR } = await import('./callback-tools.js');
  const config = getCallbackConfig(options);
  if (!config) return errorResult(NO_CONFIG_ERROR);

  try {
    const response = await fetch(`${config.apiUrl}${path}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json', ...buildAuthHeaders(config) },
    });
    if (!response.ok) {
      const text = await response.text();
      return errorResult(`Delete failed (${response.status}): ${text}`);
    }
    const { successResult: ok } = await import('./file-tools.js');
    return ok(JSON.stringify(await response.json()));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return errorResult(`Delete request failed: ${message}`);
  }
}

// ─── List templates ──────────────────────────────────────────

export const listScheduleTemplatesInputSchema = {
  agentKeyCatId: agentKeyCatIdSchema,
};

export async function handleListScheduleTemplates(input: { agentKeyCatId?: string | undefined }): Promise<ToolResult> {
  return callbackGet('/api/schedule/templates', undefined, { agentKeyCatId: input.agentKeyCatId });
}

// ─── Register scheduled task ────────────────────────────────

export const registerScheduledTaskInputSchema = {
  templateId: z
    .string()
    .min(1)
    .describe('Template ID from list_schedule_templates (e.g. "reminder", "web-digest", "repo-activity")'),
  trigger: z
    .string()
    .describe(
      'Trigger config as JSON string. Examples: {"type":"cron","expression":"0 9 * * *"} or {"type":"interval","ms":3600000} or {"type":"once","delayMs":120000} (fire once after 2min) or {"type":"once","fireAt":1712345678000} (fire once at epoch ms)',
    ),
  params: z
    .string()
    .optional()
    .describe('Template-specific parameters as JSON string (e.g. {"message":"检查 backlog"})'),
  deliveryThreadId: z
    .string()
    .optional()
    .describe(
      'Thread ID to deliver results to. If omitted on invocation-token callback requests, the current invocation thread is used. Required when agentKeyCatId is used because persistent MCP has no invocation thread.',
    ),
  label: z.string().optional().describe('Human-readable task label (defaults to template label)'),
  category: z.string().optional().describe('Display category: pr | repo | thread | system | external'),
  description: z.string().optional().describe('Short description of this task instance'),
  agentKeyCatId: agentKeyCatIdSchema,
};

export async function handleRegisterScheduledTask(input: {
  templateId: string;
  trigger: string;
  params?: string;
  deliveryThreadId?: string;
  label?: string;
  category?: string;
  description?: string;
  agentKeyCatId?: string | undefined;
}): Promise<ToolResult> {
  let trigger: unknown;
  try {
    trigger = JSON.parse(input.trigger);
  } catch {
    return errorResult('Invalid trigger JSON — must be a valid JSON object');
  }

  let params: Record<string, unknown> = {};
  if (input.params) {
    try {
      const parsed: unknown = JSON.parse(input.params);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        return errorResult('Invalid params JSON — must be a JSON object (not null, array, or primitive)');
      }
      params = parsed as Record<string, unknown>;
    } catch {
      return errorResult('Invalid params JSON — must be a valid JSON object');
    }
  }

  const authMode = resolveScheduleMcpAuthMode(input.agentKeyCatId);
  if (authMode === 'agent-key' && !input.deliveryThreadId) {
    return errorResult(
      'deliveryThreadId is required when registering scheduled tasks with agentKeyCatId. ' +
        'Persistent agent-key MCP has no invocation thread; without an explicit delivery thread, reminder/web-digest tasks would be inert.',
    );
  }

  // Auto-inject the selected cat's ID so reminder tasks wake the registering cat, not default opus.
  // Shared Antigravity MCP has no per-process CAT_CAFE_CAT_ID; the selected sidecar cat is the actor.
  const currentCatId = authMode === 'agent-key' ? input.agentKeyCatId : process.env['CAT_CAFE_CAT_ID'];
  if (!params.targetCatId && currentCatId) {
    params.targetCatId = currentCatId;
  }

  const body: Record<string, unknown> = {
    templateId: input.templateId,
    trigger,
    params,
  };

  if (input.deliveryThreadId) body.deliveryThreadId = input.deliveryThreadId;
  if (currentCatId) body.createdBy = currentCatId;

  if (input.label || input.category || input.description) {
    body.display = {
      label: input.label ?? input.templateId,
      category: input.category ?? 'system',
      ...(input.description ? { description: input.description } : {}),
    };
  }

  return callbackPost('/api/schedule/tasks', body, { agentKeyCatId: input.agentKeyCatId });
}

// ─── Preview scheduled task (AC-G2: draft step) ────────────

export const previewScheduledTaskInputSchema = {
  templateId: z.string().min(1).describe('Template ID from list_schedule_templates'),
  trigger: z.string().describe('Trigger config as JSON string'),
  params: z.string().optional().describe('Template-specific parameters as JSON string'),
  deliveryThreadId: z
    .string()
    .optional()
    .describe(
      'Thread ID to deliver results to. If omitted on invocation-token callback requests, the current invocation thread is used. Required when agentKeyCatId is used because persistent MCP has no invocation thread.',
    ),
  agentKeyCatId: agentKeyCatIdSchema,
};

export async function handlePreviewScheduledTask(input: {
  templateId: string;
  trigger: string;
  params?: string;
  deliveryThreadId?: string;
  agentKeyCatId?: string | undefined;
}): Promise<ToolResult> {
  let trigger: unknown;
  try {
    trigger = JSON.parse(input.trigger);
  } catch {
    return errorResult('Invalid trigger JSON');
  }

  let params: Record<string, unknown> = {};
  if (input.params) {
    try {
      params = JSON.parse(input.params);
    } catch {
      return errorResult('Invalid params JSON');
    }
  }

  if (resolveScheduleMcpAuthMode(input.agentKeyCatId) === 'agent-key' && !input.deliveryThreadId) {
    return errorResult(
      'deliveryThreadId is required when previewing scheduled tasks with agentKeyCatId. ' +
        'Persistent agent-key MCP has no invocation thread; preview should match the register call that will persist the task.',
    );
  }

  const body: Record<string, unknown> = {
    templateId: input.templateId,
    trigger,
    params,
  };
  if (input.deliveryThreadId) body.deliveryThreadId = input.deliveryThreadId;

  return callbackPost('/api/schedule/tasks/preview', body, { agentKeyCatId: input.agentKeyCatId });
}

// ─── Remove scheduled task ──────────────────────────────────

export const removeScheduledTaskInputSchema = {
  taskId: z.string().min(1).describe('The dynamic task ID to remove (e.g. "dyn-1711504800000-abc123")'),
  sourceThreadId: z
    .string()
    .min(1)
    .optional()
    .describe(
      'Verified source thread for the delete request. Required with agentKeyCatId because persistent MCP has no invocation thread.',
    ),
  agentKeyCatId: agentKeyCatIdSchema,
};

export async function handleRemoveScheduledTask(input: {
  taskId: string;
  sourceThreadId?: string;
  agentKeyCatId?: string;
}): Promise<ToolResult> {
  if (resolveScheduleMcpAuthMode(input.agentKeyCatId) === 'agent-key' && !input.sourceThreadId) {
    return errorResult(
      'sourceThreadId is required when removing scheduled tasks with agentKeyCatId. ' +
        'Persistent agent-key MCP has no invocation thread, so destructive proposals must name a verified owned thread.',
    );
  }
  const query = input.sourceThreadId ? `?sourceThreadId=${encodeURIComponent(input.sourceThreadId)}` : '';
  return callbackDelete(`/api/schedule/tasks/${encodeURIComponent(input.taskId)}${query}`, {
    agentKeyCatId: input.agentKeyCatId,
  });
}

// ─── Tool definitions ───────────────────────────────────────

export const scheduleTools = [
  defineTool({
    name: 'cat_cafe_list_schedule_templates',
    description:
      'List available schedule task templates. Each template defines a reusable task type (e.g. reminder, web-digest, repo-activity) ' +
      'with its parameter schema and default trigger. Use this to discover what kinds of scheduled tasks can be created. ' +
      'When a task fires, it wakes a cat via invokeTrigger — the woken cat has FULL capabilities (rich blocks, search, image generation, etc.). ' +
      'Shared persistent MCP callers pass agentKeyCatId.',
    inputSchema: listScheduleTemplatesInputSchema,
    handler: handleListScheduleTemplates,
    governance: {
      implementationExport: 'handleListScheduleTemplates',
      action: 'read',
      risk: { level: 'read', openWorld: false },
      runtimeProfiles: ['full', 'agent-key'],
    },
  }),
  defineTool({
    name: 'cat_cafe_preview_scheduled_task',
    description:
      'Preview a scheduled task before submitting it for approval. ' +
      'Use when the user asks to create a schedule and needs to confirm the resolved template, trigger, and params. ' +
      'NOT for persisting or activating a task. ' +
      'Output: one non-persisted draft to show the user before calling register_scheduled_task. ' +
      'GOTCHA: shared persistent MCP callers pass agentKeyCatId.',
    inputSchema: previewScheduledTaskInputSchema,
    handler: handlePreviewScheduledTask,
    governance: {
      implementationExport: 'handlePreviewScheduledTask',
      action: 'derive',
      risk: { level: 'write', openWorld: false },
      runtimeProfiles: ['full', 'agent-key'],
    },
  }),
  defineTool({
    name: 'cat_cafe_register_scheduled_task',
    description:
      'Submit a new scheduled task from a template for operator approval. ' +
      'Use after preview_scheduled_task when the user confirms the draft. ' +
      'NOT for direct activation or unsupported ad-hoc task definitions. ' +
      'Output: one anchored Approval Hub proposal; the task is not persisted or run until the operator approves. ' +
      'Supports cron, interval, and once triggers. ' +
      'GOTCHA: trigger and params are JSON strings; shared persistent MCP callers pass agentKeyCatId and an owned deliveryThreadId.',
    inputSchema: registerScheduledTaskInputSchema,
    handler: handleRegisterScheduledTask,
    governance: {
      implementationExport: 'handleRegisterScheduledTask',
      action: 'create',
      risk: { level: 'write', openWorld: false },
      runtimeProfiles: ['full', 'agent-key'],
    },
  }),
  defineTool({
    name: 'cat_cafe_remove_scheduled_task',
    description:
      'Request permanent removal of a user-created dynamic scheduled task by task ID. ' +
      'Use when the user asks a cat to permanently delete a scheduled task. ' +
      'NOT for pause/resume or builtin system tasks. ' +
      'Output: one anchored Approval Hub proposal; the task remains active until the operator approves. ' +
      'GOTCHA: persistent agent-key callers must pass agentKeyCatId and an owned sourceThreadId.',
    inputSchema: removeScheduledTaskInputSchema,
    handler: handleRemoveScheduledTask,
    governance: {
      implementationExport: 'handleRemoveScheduledTask',
      action: 'close',
      risk: { level: 'write', openWorld: false },
      runtimeProfiles: ['full', 'agent-key'],
    },
  }),
] as const;
