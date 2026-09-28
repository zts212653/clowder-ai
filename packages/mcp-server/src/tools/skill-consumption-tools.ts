import { exactAssetVersionRefV1Schema, reviewSubjectRefSchema } from '@cat-cafe/shared';
import { z } from 'zod';
import { defineMcpCanonicalFactory } from '../tool-governance-migration.js';
import { callbackPost } from './callback-tools.js';
import type { ToolResult } from './file-tools.js';
import {
  recordRequestReviewOwnerFactInputSchema,
  requestReviewOwnerFactSchema,
} from './request-review-owner-fact-schema.js';

export { recordRequestReviewOwnerFactInputSchema } from './request-review-owner-fact-schema.js';

const defineTool = defineMcpCanonicalFactory('skill-consumption-tools.ts', undefined, {
  resourceFamily: 'skill-consumption-receipt',
  authority: 'callback-owner-private',
});

const admissionReason = {
  disposition: 'accepted-boundary' as const,
  kind: 'resource-entry' as const,
  admissionRef: 'file:docs/architecture/skill-consumption-receipt-contract.md' as const,
};

const ownerFactAdmissionReason = {
  disposition: 'accepted-boundary' as const,
  kind: 'resource-entry' as const,
  admissionRef: 'file:docs/features/F311-capability-evolution-workspace.md' as const,
};

type CallbackPost = (path: string, body: Record<string, unknown>) => Promise<ToolResult>;

const preparedHandleSchema = z
  .string()
  .trim()
  .min(1)
  .max(2_000)
  .describe('Opaque revision- and invocation-bound handle returned by the matching prepare-consumption tool.');

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

export const prepareRequestReviewConsumptionInputSchema = {
  assetVersionRef: exactAssetVersionRefV1Schema.describe(
    'Exact F100 request-review SKILL.md AssetVersionRef selected for this review request.',
  ),
  reviewerCatId: z
    .string()
    .trim()
    .min(1)
    .max(120)
    .describe('Stable non-author reviewer cat id, for example codex-terra.'),
  reviewSubjectRef: reviewSubjectRefSchema.describe('Stable local-review subject, for example pr:owner/repo#123.'),
  reviewedHeadSha: z
    .string()
    .regex(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/)
    .describe('Exact Git HEAD the reviewer must cover.'),
  acceptedSourceRef: z
    .string()
    .trim()
    .min(1)
    .max(2_000)
    .describe('Canonical accepted source path or immutable threadId#messageId.'),
  acceptedRevision: z
    .string()
    .trim()
    .min(1)
    .max(2_000)
    .describe('Exact accepted-source revision the typed verdict must repeat.'),
};

export const bindRequestReviewConsumptionInputSchema = { handle: preparedHandleSchema };

export const recordRequestReviewConsumptionInputSchema = {
  handle: preparedHandleSchema,
  reviewMessageId: z
    .string()
    .trim()
    .min(1)
    .max(240)
    .describe('Exact durable message id returned by the typed local-review post_message call.'),
};

export const dismissRequestReviewConsumptionInputSchema = {
  handle: preparedHandleSchema,
  reason: z
    .enum(['outside_local_review_scope', 'request_not_reviewable', 'route_replaced'])
    .describe('Bounded reviewer-owned reason why the prepared local-review consumer was not applied.'),
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

  const handlePrepareRequestReviewConsumption = (input: {
    assetVersionRef: z.infer<typeof exactAssetVersionRefV1Schema>;
    reviewerCatId: string;
    reviewSubjectRef: string;
    reviewedHeadSha: string;
    acceptedSourceRef: string;
    acceptedRevision: string;
  }) => callbackPost('/api/callbacks/request-review-consumption/prepare', input);

  const handleBindRequestReviewConsumption = (input: { handle: string }) =>
    callbackPost('/api/callbacks/request-review-consumption/bind', input);

  const handleRecordRequestReviewConsumption = (input: { handle: string; reviewMessageId: string }) =>
    callbackPost('/api/callbacks/request-review-consumption/record', input);

  const handleDismissRequestReviewConsumption = (input: {
    handle: string;
    reason: 'outside_local_review_scope' | 'request_not_reviewable' | 'route_replaced';
  }) => callbackPost('/api/callbacks/request-review-consumption/dismiss', input);

  const handleRecordRequestReviewOwnerFact = (input: { fact: z.infer<typeof requestReviewOwnerFactSchema> }) =>
    callbackPost('/api/callbacks/request-review-owner/facts', input.fact);

  return {
    handlePrepareSkillConsumption,
    handleOpenWithWorkspaceNavigator,
    handleDismissSkillConsumption,
    handlePrepareRequestReviewConsumption,
    handleBindRequestReviewConsumption,
    handleRecordRequestReviewConsumption,
    handleDismissRequestReviewConsumption,
    handleRecordRequestReviewOwnerFact,
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
        name: 'cat_cafe_record_request_review_owner_fact',
        description:
          'Record one Git/load-verified F100 request-review owner fact and link intervention or fresh outcome facts into canonical F266 lifecycle truth. ' +
          'Use after an accepted/materialized exact repair has real merge/load, evidence, outcome, no-change, or rollback proof. ' +
          'NOT for proposing/approving repair, creating Task or lease custody, recording local-review use, or fabricating production activation. ' +
          'Output: a durable F100 receipt plus F266 lifecycle result where applicable; only the exact active Task/F167 carrier invocation may write it. ' +
          'GOTCHA: invalid custody, approval, semantic transition, main/live/time, or rollback lineage has zero owner effects; merge, load, use, and fresh outcome remain separate facts.',
        inputSchema: recordRequestReviewOwnerFactInputSchema,
        handler: handleRecordRequestReviewOwnerFact,
        governance: {
          implementationExport: 'handleRecordRequestReviewOwnerFact',
          resourceFamily: 'evolution-program',
          action: 'update',
          risk: { level: 'write', openWorld: false },
          runtimeProfiles: ['full'],
          standaloneReason: ownerFactAdmissionReason,
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
      defineTool({
        name: 'cat_cafe_prepare_request_review_consumption',
        description:
          'Reserve one exact request-review semantic revision and review HEAD/source tuple for a named non-author local-review consumer. ' +
          'Use after reading request-review and before sending the ordinary review request. ' +
          'NOT for posting the request, approving code, or claiming the skill was applied. ' +
          'Output: a durable opaque handle to place on the exact Request-Review-Consumption-Handle template line. ' +
          'GOTCHA: only a strict author invocation with a real origin can reserve; preparation alone is not use, and the routed reviewer must bind it from the resulting invocation before recording the typed verdict message.',
        inputSchema: prepareRequestReviewConsumptionInputSchema,
        handler: handlePrepareRequestReviewConsumption,
        governance: {
          implementationExport: 'handlePrepareRequestReviewConsumption',
          action: 'create',
          risk: { level: 'write', openWorld: false },
          runtimeProfiles: ['full'],
          standaloneReason: admissionReason,
        },
      }),
      defineTool({
        name: 'cat_cafe_bind_request_review_consumption',
        description:
          'Bind a prepared request-review handle to this exact routed reviewer invocation before reviewing. ' +
          'Use when a review request contains Request-Review-Consumption-Handle and this invocation is its named reviewer. ' +
          'NOT for authors, unrelated invocations, review verdicts, or generic skill loading. ' +
          'Output: a durable bound/duplicate reservation plus the server-observed mounted package and semantic revision, with no review or approval side effect. ' +
          'GOTCHA: the server verifies reviewer cat, strict invocation origin, request message, thread, handle line, and managed runtime mount; an unverifiable mount stays unconfirmed and binding does not prove the package was read.',
        inputSchema: bindRequestReviewConsumptionInputSchema,
        handler: handleBindRequestReviewConsumption,
        governance: {
          implementationExport: 'handleBindRequestReviewConsumption',
          action: 'update',
          risk: { level: 'write', openWorld: false },
          runtimeProfiles: ['full'],
          standaloneReason: admissionReason,
        },
      }),
      defineTool({
        name: 'cat_cafe_record_request_review_consumption',
        description:
          'Resolve a bound request-review reservation against one durable typed local-review message. ' +
          'Use immediately after the named reviewer posts localReviewVerdict for the reserved review subject. ' +
          'NOT for creating the verdict, deciding merge approval, or inferring use from prose or a generic callback. ' +
          'Output: one exact-version applied or unconfirmed F100 use receipt bound to the F299 reviewer invocation and reserved HEAD/source tuple. ' +
          'GOTCHA: approved and changes_requested are both possible applied uses; a mismatched HEAD/source or unattested mounted revision remains rejected/unconfirmed and never becomes applied.',
        inputSchema: recordRequestReviewConsumptionInputSchema,
        handler: handleRecordRequestReviewConsumption,
        governance: {
          implementationExport: 'handleRecordRequestReviewConsumption',
          action: 'update',
          risk: { level: 'write', openWorld: false },
          runtimeProfiles: ['full'],
          standaloneReason: admissionReason,
        },
      }),
      defineTool({
        name: 'cat_cafe_dismiss_request_review_consumption',
        description:
          'Record that this exact bound reviewer invocation did not apply the prepared request-review consumer. ' +
          'Use after binding when the request is outside local-review scope, not reviewable, or replaced by another route. ' +
          'NOT for review findings, merge verdicts, author cancellation, or an unbound preparation. ' +
          'Output: one durable exact-version dismissed receipt bound to the reviewer F299 invocation. ' +
          'GOTCHA: dismissal is terminal for this reservation; a later typed verdict cannot overwrite it.',
        inputSchema: dismissRequestReviewConsumptionInputSchema,
        handler: handleDismissRequestReviewConsumption,
        governance: {
          implementationExport: 'handleDismissRequestReviewConsumption',
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
export const {
  handlePrepareSkillConsumption,
  handleOpenWithWorkspaceNavigator,
  handleDismissSkillConsumption,
  handlePrepareRequestReviewConsumption,
  handleBindRequestReviewConsumption,
  handleRecordRequestReviewConsumption,
  handleDismissRequestReviewConsumption,
  handleRecordRequestReviewOwnerFact,
} = skillConsumptionToolset;
export const skillConsumptionTools = skillConsumptionToolset.tools;
