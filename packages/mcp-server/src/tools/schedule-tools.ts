/**
 * F139 Phase 3A: Schedule MCP Tools (AC-G2)
 *
 * cat_cafe_list_schedule_templates  — list available task templates
 * cat_cafe_register_scheduled_task  — create a dynamic scheduled task from template
 * cat_cafe_remove_scheduled_task    — delete a dynamic scheduled task
 */

import { z } from 'zod';
import { callbackGet, callbackPost } from './callback-tools.js';
import type { ToolResult } from './file-tools.js';
import { errorResult } from './file-tools.js';

// ─── callbackDelete (schedule-specific) ──────────────────────

async function callbackDelete(path: string): Promise<ToolResult> {
  const { getCallbackConfig, buildAuthHeaders, NO_CONFIG_ERROR } = await import('./callback-tools.js');
  const config = getCallbackConfig();
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

export const listScheduleTemplatesInputSchema = {};

export async function handleListScheduleTemplates(_input: Record<string, never>): Promise<ToolResult> {
  return callbackGet('/api/schedule/templates');
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
      'Thread ID to deliver results to. If omitted on callback-origin requests, the current invocation thread is used',
    ),
  label: z.string().optional().describe('Human-readable task label (defaults to template label)'),
  category: z.string().optional().describe('Display category: pr | repo | thread | system | external'),
  description: z.string().optional().describe('Short description of this task instance'),
};

export async function handleRegisterScheduledTask(input: {
  templateId: string;
  trigger: string;
  params?: string;
  deliveryThreadId?: string;
  label?: string;
  category?: string;
  description?: string;
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

  // Auto-inject current cat's ID so reminder tasks wake the registering cat, not default opus
  const currentCatId = process.env['CAT_CAFE_CAT_ID'];
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

  return callbackPost('/api/schedule/tasks', body);
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
      'Thread ID to deliver results to. If omitted on callback-origin requests, the current invocation thread is used',
    ),
};

export async function handlePreviewScheduledTask(input: {
  templateId: string;
  trigger: string;
  params?: string;
  deliveryThreadId?: string;
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

  const body: Record<string, unknown> = {
    templateId: input.templateId,
    trigger,
    params,
  };
  if (input.deliveryThreadId) body.deliveryThreadId = input.deliveryThreadId;

  return callbackPost('/api/schedule/tasks/preview', body);
}

// ─── Remove scheduled task ──────────────────────────────────

export const removeScheduledTaskInputSchema = {
  taskId: z.string().min(1).describe('The dynamic task ID to remove (e.g. "dyn-1711504800000-abc123")'),
};

export async function handleRemoveScheduledTask(input: { taskId: string }): Promise<ToolResult> {
  return callbackDelete(`/api/schedule/tasks/${encodeURIComponent(input.taskId)}`);
}

// ─── Tool definitions ───────────────────────────────────────

export const scheduleTools = [
  {
    name: 'cat_cafe_list_schedule_templates',
    description:
      'List available schedule task templates. Each template defines a reusable task type (e.g. reminder, web-digest, repo-activity) ' +
      'with its parameter schema and default trigger. Use this to discover what kinds of scheduled tasks can be created. ' +
      'When a task fires, it wakes a cat via invokeTrigger — the woken cat has FULL capabilities (rich blocks, search, image generation, etc.).',
    inputSchema: listScheduleTemplatesInputSchema,
    handler: handleListScheduleTemplates,
  },
  {
    name: 'cat_cafe_preview_scheduled_task',
    description:
      'Preview a scheduled task BEFORE creating it (draft step). Returns a draft with resolved template info, trigger, and params ' +
      'WITHOUT persisting anything. Show this draft to the user for confirmation before calling register_scheduled_task. ' +
      'REQUIRED: Always preview first, then register only after user confirms.',
    inputSchema: previewScheduledTaskInputSchema,
    handler: handlePreviewScheduledTask,
  },
  {
    name: 'cat_cafe_register_scheduled_task',
    description:
      'Create a new scheduled task from a template (confirm step). The task will be persisted and run automatically on schedule. ' +
      'Supports recurring (cron/interval) and one-shot (once) triggers. Once tasks auto-retire after execution. ' +
      'When the task fires, a cat is woken with full capabilities — it can send rich blocks (images, audio, cards), search the web, generate content, etc. ' +
      'IMPORTANT: You MUST call preview_scheduled_task first and get user confirmation before calling this. ' +
      'trigger and params must be JSON strings, not objects.',
    inputSchema: registerScheduledTaskInputSchema,
    handler: handleRegisterScheduledTask,
  },
  {
    name: 'cat_cafe_remove_scheduled_task',
    description:
      'Remove a dynamic scheduled task by its task ID. This stops the task and deletes it permanently. ' +
      'Only works for user-created dynamic tasks, not builtin system tasks.',
    inputSchema: removeScheduledTaskInputSchema,
    handler: handleRemoveScheduledTask,
  },
] as const;
