import { z } from 'zod';
import { defineMcpCanonicalFactory } from '../tool-governance-migration.js';
import { callbackPost, getCallbackConfig } from './callback-tools.js';
import { errorResult, type ToolResult } from './file-tools.js';

const defineTool = defineMcpCanonicalFactory('schedule-parameter-tools.ts', undefined, {
  resourceFamily: 'schedule',
  authority: 'callback-owner',
});

export const updateScheduledTaskParamsInputSchema = {
  taskId: z.string().min(1).describe('Existing recurring dynamic task ID; the subscription identity is preserved.'),
  paramsPatch: z
    .string()
    .min(1)
    .describe(
      'Non-empty JSON object of template parameters to merge, e.g. {"executionCarrier":"managed"}. Omitted parameters keep their current values.',
    ),
  sourceThreadId: z
    .string()
    .min(1)
    .optional()
    .describe(
      'Owned thread for the approval card. Required for persistent agent-key callers; invocation callers use their authenticated thread.',
    ),
  agentKeyCatId: z
    .string()
    .min(1)
    .optional()
    .describe('Persistent-agent identity selector; ignored when invocation credentials are present.'),
};

export async function handleUpdateScheduledTaskParams(input: {
  taskId: string;
  paramsPatch: string;
  sourceThreadId?: string;
  agentKeyCatId?: string;
}): Promise<ToolResult> {
  let paramsPatch: unknown;
  try {
    paramsPatch = JSON.parse(input.paramsPatch);
  } catch {
    return errorResult('paramsPatch must be a non-empty JSON object');
  }
  if (
    !paramsPatch ||
    typeof paramsPatch !== 'object' ||
    Array.isArray(paramsPatch) ||
    !Object.keys(paramsPatch).length
  ) {
    return errorResult('paramsPatch must be a non-empty JSON object');
  }
  const config = getCallbackConfig({ agentKeyCatId: input.agentKeyCatId });
  if (config?.agentKeySecret && !(config.invocationId && config.callbackToken) && !input.sourceThreadId) {
    return errorResult('sourceThreadId is required for a persistent agent-key parameter update proposal');
  }
  return callbackPost(
    `/api/schedule/tasks/${encodeURIComponent(input.taskId)}/parameters`,
    {
      paramsPatch,
      ...(input.sourceThreadId ? { sourceThreadId: input.sourceThreadId } : {}),
    },
    { agentKeyCatId: input.agentKeyCatId },
  );
}

export const scheduleParameterTools = [
  defineTool({
    name: 'cat_cafe_update_scheduled_task_params',
    description:
      'Propose changes to template parameters of an existing recurring scheduled task. ' +
      'Use when changing a reminder or subscription while preserving its task ID, trigger, delivery thread and cursor. ' +
      'NOT for creating, deleting, pausing, changing the trigger/destination, or modifying managed owner tasks. ' +
      'Output: an anchored Approval Hub proposal with before/after values; no task changes until the operator approves. ' +
      'GOTCHA: paramsPatch is a JSON object string, omitted values are preserved, and a changed task definition requires a fresh proposal. Active runs keep their original settings. Persistent agent-key callers need agentKeyCatId and an owned sourceThreadId.',
    inputSchema: updateScheduledTaskParamsInputSchema,
    handler: handleUpdateScheduledTaskParams,
    governance: {
      implementationExport: 'handleUpdateScheduledTaskParams',
      action: 'update',
      risk: { level: 'write', openWorld: false },
      runtimeProfiles: ['full', 'agent-key'],
      standaloneReason: {
        disposition: 'accepted-boundary',
        kind: 'mode-matrix-boundary',
        admissionRef: 'file:docs/features/F286-mcp-surface-lifecycle-governance.md',
      },
    },
  }),
] as const;
