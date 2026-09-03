import { z } from 'zod';
import { defineMcpCanonicalFactory } from '../tool-governance-migration.js';
import { callbackPost } from './callback-tools.js';
import type { ToolResult } from './file-tools.js';

const defineTool = defineMcpCanonicalFactory('skill-consumption-tools.ts', undefined, {
  resourceFamily: 'skill-consumption-receipt',
  authority: 'callback-owner-private',
});

const admissionReason = {
  disposition: 'accepted-boundary' as const,
  kind: 'resource-entry' as const,
  admissionRef: 'file:docs/architecture/skill-consumption-receipt-contract.md' as const,
};

type CallbackPost = (path: string, body: Record<string, unknown>) => Promise<ToolResult>;

const preparedHandleSchema = z
  .string()
  .trim()
  .min(1)
  .max(2_000)
  .describe('Opaque revision- and invocation-bound handle returned by cat_cafe_prepare_skill_consumption.');

export const prepareSkillConsumptionInputSchema = {
  skillId: z
    .literal('workspace-navigator')
    .describe('Pilot skill package whose current revision will be bound to the Workspace navigation consumer.'),
};

export const dismissSkillConsumptionInputSchema = {
  handle: preparedHandleSchema,
  reason: z
    .enum(['alternate_native_shortcut', 'outside_skill_scope'])
    .describe('Bounded Workspace consumer decision explaining why the prepared skill was not applied.'),
};

export const openWithWorkspaceNavigatorInputSchema = {
  handle: preparedHandleSchema,
  path: z
    .string()
    .min(1)
    .describe('Codex-native absolute file path, or a repo-relative file path when worktreeId is provided.'),
  worktreeId: z
    .string()
    .min(1)
    .optional()
    .describe('Target worktree id for repo-relative paths; omit when path is absolute.'),
  line: z.number().int().min(1).optional().describe('Optional 1-based line number to focus after opening the file.'),
  threadId: z
    .string()
    .min(1)
    .optional()
    .describe('Current Clowder AI thread id; omit to use the thread bound to invocation auth.'),
};

export function createSkillConsumptionTools(callbackPost: CallbackPost) {
  const handlePrepareSkillConsumption = (input: { skillId: 'workspace-navigator' }) =>
    callbackPost('/api/callbacks/skill-consumption/prepare', { skillId: input.skillId });

  const handleOpenWithWorkspaceNavigator = (input: {
    handle: string;
    path: string;
    worktreeId?: string;
    line?: number;
    threadId?: string;
  }) =>
    callbackPost('/api/workspace/navigate', {
      skillConsumptionHandle: input.handle,
      path: input.path,
      action: 'open',
      ...(input.worktreeId ? { worktreeId: input.worktreeId } : {}),
      ...(input.line === undefined ? {} : { line: input.line }),
      ...(input.threadId ? { threadId: input.threadId } : {}),
    });

  const handleDismissSkillConsumption = (input: {
    handle: string;
    reason: 'alternate_native_shortcut' | 'outside_skill_scope';
  }) =>
    callbackPost('/api/callbacks/skill-consumption/dismiss', {
      handle: input.handle,
      reason: input.reason,
    });

  return {
    handlePrepareSkillConsumption,
    handleOpenWithWorkspaceNavigator,
    handleDismissSkillConsumption,
    tools: [
      defineTool({
        name: 'cat_cafe_prepare_skill_consumption',
        description:
          'Prepare an opaque handle binding the current workspace-navigator package revision to this exact invocation and its declared Workspace consumer. ' +
          'Use after fully reading that skill and before either opening a file through cat_cafe_open_with_workspace_navigator or dismissing it. ' +
          'NOT for recording applied/dismissed, selecting skills, proving task success, or preparing any unlisted skill family. ' +
          'Output: a short-lived prepared handle and revision coordinate; preparation is not a consumption receipt. ' +
          'GOTCHA: the handle or later receipt does not prove the package was read; agent-key and readonly/desktop carriers are unsupported because they cannot prove the same invocation.',
        inputSchema: prepareSkillConsumptionInputSchema,
        handler: handlePrepareSkillConsumption,
        governance: {
          implementationExport: 'handlePrepareSkillConsumption',
          action: 'derive',
          risk: { level: 'read', openWorld: false },
          runtimeProfiles: ['full'],
          standaloneReason: admissionReason,
        },
      }),
      defineTool({
        name: 'cat_cafe_open_with_workspace_navigator',
        description:
          'Open one file through the existing Workspace navigation consumer while consuming a prepared workspace-navigator revision in the same invocation. ' +
          'Use only after cat_cafe_prepare_skill_consumption returned the handle and the resolved target is a file that should be opened. ' +
          'NOT for directories/reveal, preparing or dismissing consumption, scoring the skill, or claiming task success. ' +
          'Output: the Workspace deliveryStatus plus one revision-bound applied receipt whose outcome is limited to that delivery decision. ' +
          'GOTCHA: queued, blocked, and unconfirmed remain applied-to-consumer outcomes but do not prove the user saw the file; agent-key/readonly/desktop carriers are unsupported.',
        inputSchema: openWithWorkspaceNavigatorInputSchema,
        handler: handleOpenWithWorkspaceNavigator,
        governance: {
          implementationExport: 'handleOpenWithWorkspaceNavigator',
          action: 'command',
          risk: { level: 'write', openWorld: false },
          runtimeProfiles: ['full'],
          standaloneReason: admissionReason,
        },
      }),
      defineTool({
        name: 'cat_cafe_dismiss_skill_consumption',
        description:
          'Record a revision-bound dismissed receipt for a prepared workspace-navigator skill in the same authenticated invocation and Workspace consumer. ' +
          'Use when the prepared skill is not applicable or the consumer chooses its native shortcut instead. ' +
          'NOT for recording applied (only cat_cafe_open_with_workspace_navigator may do that), scoring skill quality, or claiming task success. ' +
          'Output: one content-free dismissed receipt with a bounded not_applicable consumer decision. ' +
          'GOTCHA: agent-key and readonly/desktop carriers are unsupported; stale package revisions and replayed handles fail closed.',
        inputSchema: dismissSkillConsumptionInputSchema,
        handler: handleDismissSkillConsumption,
        governance: {
          implementationExport: 'handleDismissSkillConsumption',
          action: 'update',
          risk: { level: 'write', openWorld: false },
          runtimeProfiles: ['full'],
          standaloneReason: admissionReason,
        },
      }),
    ],
  };
}

export const skillConsumptionToolset = createSkillConsumptionTools(callbackPost);
export const { handlePrepareSkillConsumption, handleOpenWithWorkspaceNavigator, handleDismissSkillConsumption } =
  skillConsumptionToolset;
export const skillConsumptionTools = skillConsumptionToolset.tools;
