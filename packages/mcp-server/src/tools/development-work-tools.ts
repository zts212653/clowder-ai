import { type DevelopmentWorkActionV1, developmentWorkActionV1Schema } from '@cat-cafe/shared';
import { callbackPost } from './callback-tools.js';
import { defineDevelopmentTool } from './development-tool-definition.js';
import type { ToolResult } from './file-tools.js';

export const developmentWorkInputSchema = {
  ...developmentWorkActionV1Schema.shape,
  action: developmentWorkActionV1Schema.shape.action
    .exclude(['resolve'])
    .describe(
      'Resolve first; admit new work, resume open scoped work, adopt an exact generic Task, or bind scope to existing entrusted work.',
    ),
  scope: developmentWorkActionV1Schema.shape.scope.describe(
    'Canonical Feature ID (feature:F310), declared Phase key (B, 1, 1.5, 1b) and exact accepted Git revision. Omit workUnitRef to reuse your own open sub-work; explicit feature-phase:<id>:<key> selects the Phase itself. Sub-work needs an existing Task or accepted plan anchor.',
  ),
  admission: developmentWorkActionV1Schema.shape.admission.describe(
    'Exact current human source and action idempotency key. New messages authorize actions, not new work identities.',
  ),
  sourceMessageRevision: developmentWorkActionV1Schema.shape.sourceMessageRevision.describe(
    'Current Message-owner sha256 revision of that human source; stale sources are rejected.',
  ),
  taskId: developmentWorkActionV1Schema.shape.taskId.describe(
    'Exact Task ID from resolve; required for resume/adopt/bind. Never infer from a title.',
  ),
  expectedRevision: developmentWorkActionV1Schema.shape.expectedRevision.describe(
    'Current entrusted-work revision from owner resolve; required for resume/bind.',
  ),
  expectedSnapshot: developmentWorkActionV1Schema.shape.expectedSnapshot.describe(
    'Owner-issued snapshot from resolve; required for legacy adoption.',
  ),
  title: developmentWorkActionV1Schema.shape.title.describe(
    'Human-readable title for newly admitted work; existing identity/title remain unchanged.',
  ),
  why: developmentWorkActionV1Schema.shape.why.describe('Reason for accepting this scoped development outcome.'),
  closure: developmentWorkActionV1Schema.shape.closure.describe(
    'Accepted outcome and verifiable completion signal; needed for admit/adopt.',
  ),
  time: developmentWorkActionV1Schema.shape.time.describe(
    'Exact-source-backed businessDeadline, reviewBy, plannedStart, actualStart or estimatedCompletion in epoch milliseconds. Preserve each meaning; omit unknown dates.',
  ),
  artifactRefs: developmentWorkActionV1Schema.shape.artifactRefs.describe(
    'Existing Artifact-owner refs at admission/adoption; later publications use update_entrusted_work.',
  ),
  parentTaskRef: developmentWorkActionV1Schema.shape.parentTaskRef.describe(
    'Optional exact open parent Task ref for an explicitly accepted sub-work; does not transfer parent ownership.',
  ),
  predecessorTaskRef: developmentWorkActionV1Schema.shape.predecessorTaskRef.describe(
    'Optional exact terminal predecessor for a newly authorized outcome; never reopens it.',
  ),
};

export async function handleDevelopmentWork(input: DevelopmentWorkActionV1): Promise<ToolResult> {
  return callbackPost('/api/callbacks/development-work', developmentWorkActionV1Schema.parse(input));
}
export async function handleResolveDevelopmentWork(
  input: Pick<DevelopmentWorkActionV1, 'scope' | 'admission' | 'sourceMessageRevision'>,
): Promise<ToolResult> {
  return handleDevelopmentWork({ ...input, action: 'resolve' });
}

export const developmentWorkTools = [
  defineDevelopmentTool({
    name: 'cat_cafe_resolve_development_work',
    description:
      'Resolve an authorized Feature/Phase to its original responsibility without creating work. Use when: accepted development starts or the human asks to continue the same Phase. Not for: casual mentions, unaccepted scope or another thread’s Task. Output: stable scope plus same-owner Task snapshot/revision and resume/adopt/bind disposition, or a content-free scope_unavailable_here. GOTCHA: scope_unverifiable is retryable source-read uncertainty, never permission to create another Task. scope_invalid requires checking the accepted declaration; scope_ambiguous requires an accepted exact unit. Read the human source and continue with the returned identity.',
    inputSchema: {
      scope: developmentWorkInputSchema.scope,
      admission: developmentWorkInputSchema.admission,
      sourceMessageRevision: developmentWorkInputSchema.sourceMessageRevision,
    },
    handler: handleResolveDevelopmentWork,
    sourceFile: 'development-work-tools.ts',
    exportName: 'handleResolveDevelopmentWork',
    callbackFile: 'callback-development-work-routes.ts',
    actions: ['resolve'],
  }),
  defineDevelopmentTool({
    name: 'cat_cafe_development_work',
    description:
      'Durably accept or continue development through the original Task owner. ' +
      'Use when: an accepted Feature kickoff becomes authorized work, or the human says “继续 Phase C / continue this phase” in its original thread, including work without a deadline. ' +
      'Not for: casual Feature mentions, unaccepted ideas, media/research without Feature scope (use admit_entrusted_work), or moving another thread’s Task. ' +
      'Output: a typed admitted/resumed/adopted/bound receipt after an atomic Task mutation. ' +
      'GOTCHA: call resolve_development_work first and reuse its Task identity. scope_unavailable_here permits no duplicate admission. A receipt alone does not deliver the work—continue the accepted action and publish real results.',
    inputSchema: developmentWorkInputSchema,
    handler: handleDevelopmentWork,
    sourceFile: 'development-work-tools.ts',
    exportName: 'handleDevelopmentWork',
    callbackFile: 'callback-development-work-routes.ts',
    actions: ['admit', 'resume', 'adopt', 'bind'],
  }),
] as const;
