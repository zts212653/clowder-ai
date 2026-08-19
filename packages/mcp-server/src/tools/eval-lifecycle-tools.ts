import { z } from 'zod';
import { defineMcpMigrationFactory } from '../tool-governance-migration.js';

import { callbackPost } from './callback-tools.js';
import type { ToolResult } from './file-tools.js';

const defineTool = defineMcpMigrationFactory('eval-lifecycle-tools.ts', undefined, {
  resourceFamily: 'eval-feedback',
  authority: 'eval-lifecycle-callback',
});

const nonEmpty = z.string().trim().min(1);
const commitSha = z.string().regex(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/);
const refKind = z.enum(['verdict', 'message', 'task', 'plan', 'commit', 'pull_request', 'reeval', 'sla', 'other']);
const lifecycleRef = z.discriminatedUnion('availability', [
  z.object({ kind: refKind, availability: z.literal('available'), value: nonEmpty }).strict(),
  z.object({ kind: refKind, availability: z.literal('unavailable'), unavailableReason: nonEmpty }).strict(),
]);

const action = z.discriminatedUnion('type', [
  z.object({ type: z.literal('plan_action') }).strict(),
  z.object({ type: z.literal('record_main_landed'), commitSha }).strict(),
  z.object({ type: z.literal('record_live_active'), commitSha }).strict(),
  z.object({ type: z.literal('request_reeval') }).strict(),
  z.object({ type: z.literal('record_reeval_result'), result: z.enum(['passed', 'failed']) }).strict(),
]);

const agentKeyCatId = nonEmpty
  .optional()
  .describe(
    'Persistent-agent identity selector. Required for shared agent-key MCP variants; ignored under invocation auth.',
  );

export const recordEvalLifecycleInputSchema = {
  verdictId: nonEmpty.describe('Immutable verdictId whose stable case receives the writeback.'),
  eventId: nonEmpty.describe('Stable idempotency key for this exact lifecycle fact.'),
  expectedSequence: z.number().int().nonnegative().describe('Current canonical case sequence.'),
  reason: nonEmpty.describe('Evidence-based reason for this lifecycle fact.'),
  refs: z.array(lifecycleRef).min(1).describe('Caller evidence; server adds main/live verification refs.'),
  action: action.describe('Owner/eval action. Main/live facts are independently verified by the API.'),
  agentKeyCatId,
};

export interface RecordEvalLifecycleInput {
  verdictId: string;
  eventId: string;
  expectedSequence: number;
  reason: string;
  refs: Array<z.infer<typeof lifecycleRef>>;
  action: z.infer<typeof action>;
  agentKeyCatId?: string;
}

export async function handleRecordEvalLifecycle(input: RecordEvalLifecycleInput): Promise<ToolResult> {
  const { verdictId, agentKeyCatId, action: lifecycleAction, ...base } = input;
  return callbackPost(
    `/api/eval-verdicts/${encodeURIComponent(verdictId)}/lifecycle-events`,
    { ...base, ...lifecycleAction },
    { agentKeyCatId },
  );
}

export const evalLifecycleTools = [
  defineTool({
    name: 'cat_cafe_record_eval_lifecycle',
    description:
      'Write one authenticated fact to an actionable eval finding stable-case lifecycle. ' +
      'Use when: the assigned owner records an action plan, verified main/live commit, or requests re-evaluation; the pinned eval cat records pass/fail. ' +
      'NOT for: acknowledging without a durable task/F167 lease, caller-authored actor/SLA, suppressing on behalf of operator, fabricating runtime activation, or creating a second task for a repeated verdict cycle. ' +
      'Output: appended/duplicate/conflict plus the replayed stable-case projection with task, lease, main, live, and re-eval state. ' +
      'GOTCHA: main and live are separate server-verified facts; use the same commit and current case sequence.',
    inputSchema: recordEvalLifecycleInputSchema,
    handler: handleRecordEvalLifecycle,
    governance: {
      implementationExport: 'handleRecordEvalLifecycle',
      action: 'update',
      risk: { level: 'write', openWorld: false },
      runtimeProfiles: ['full', 'agent-key'],
    },
  }),
] as const;
