import { PAW_FEEL_DISPOSITION_STATES, PAW_FEEL_INBOX_SORTS, PAW_FEEL_NO_ACTION_REASONS } from '@cat-cafe/shared';
import { z } from 'zod';
import { callbackGet, callbackPost } from './callback-tools.js';
import type { ToolResult } from './file-tools.js';

const nonEmpty = z.string().trim().min(1);
const agentKeyCatIdSchema = z
  .string()
  .trim()
  .min(1)
  .optional()
  .describe(
    'Persistent-agent identity selector. Required for shared agent-key MCP variants; ignored under invocation auth.',
  );

const bundleActionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('duplicate'), duplicateOf: nonEmpty }).strict(),
  z
    .object({
      type: z.literal('no_action'),
      reasonCode: z.enum(PAW_FEEL_NO_ACTION_REASONS),
    })
    .strict(),
  z.object({ type: z.literal('fix'), leaseId: nonEmpty }).strict(),
]);

const bundleMemberSchema = z
  .object({
    signalId: nonEmpty,
    expectedSequence: z.number().int().nonnegative(),
  })
  .strict();

export const listPawFeelInboxInputSchema = {
  states: z.array(z.enum(PAW_FEEL_DISPOSITION_STATES)).min(1).optional().describe('Optional state filter.'),
  sourceCatId: nonEmpty.optional().describe('Optional reporting-cat filter.'),
  sourceMessageId: nonEmpty.optional().describe('Optional exact original-message filter.'),
  overdueOnly: z.boolean().optional().describe('Return only active reports at least 72h old.'),
  limit: z.number().int().min(1).max(50).optional().describe('Review bundles per page; defaults to 50.'),
  cursor: nonEmpty.optional().describe('Opaque bundle-level nextCursor from a previous page.'),
  sort: z.enum(PAW_FEEL_INBOX_SORTS).optional().describe('Newest or oldest active bundles first.'),
  agentKeyCatId: agentKeyCatIdSchema,
};

export interface ListPawFeelInboxInput {
  states?: Array<(typeof PAW_FEEL_DISPOSITION_STATES)[number]>;
  sourceCatId?: string;
  sourceMessageId?: string;
  overdueOnly?: boolean;
  limit?: number;
  cursor?: string;
  sort?: (typeof PAW_FEEL_INBOX_SORTS)[number];
  agentKeyCatId?: string;
}

export async function handleListPawFeelInbox(input: ListPawFeelInboxInput): Promise<ToolResult> {
  const params: Record<string, string> = {};
  if (input.states) params.states = input.states.join(',');
  if (input.sourceCatId) params.sourceCatId = input.sourceCatId;
  if (input.sourceMessageId) params.sourceMessageId = input.sourceMessageId;
  if (input.overdueOnly !== undefined) params.overdueOnly = String(input.overdueOnly);
  if (input.limit !== undefined) params.limit = String(input.limit);
  if (input.cursor) params.cursor = input.cursor;
  if (input.sort) params.sort = input.sort;
  return callbackGet('/api/callbacks/paw-feel-inbox', params, {
    agentKeyCatId: input.agentKeyCatId,
  });
}

export const capturePawFeelInputSchema = {};

export type CapturePawFeelInput = Record<string, never>;

export async function handleCapturePawFeel(_input: CapturePawFeelInput): Promise<ToolResult> {
  return callbackPost('/api/callbacks/paw-feel-capture-intent', {});
}

export const triagePawFeelInputSchema = {
  bundleKey: nonEmpty.describe('Authoritative bundleKey returned by cat_cafe_list_paw_feel_inbox.'),
  eventIdPrefix: nonEmpty.describe('Stable idempotency prefix for this one bundle confirmation.'),
  members: z
    .array(bundleMemberSchema)
    .min(1)
    .max(50)
    .describe('Exact signalId + sequence snapshot returned in the review bundle.'),
  action: bundleActionSchema.describe('One common duplicate, reasoned no_action, or verified fix action.'),
  exceptions: z
    .array(z.object({ signalId: nonEmpty, action: bundleActionSchema }).strict())
    .max(50)
    .optional()
    .describe('Only members whose action differs from the common action. O(exceptions).'),
  agentKeyCatId: agentKeyCatIdSchema,
};

export type TriagePawFeelInput = {
  bundleKey: string;
  eventIdPrefix: string;
  members: Array<z.infer<typeof bundleMemberSchema>>;
  action: z.infer<typeof bundleActionSchema>;
  exceptions?: Array<{ signalId: string; action: z.infer<typeof bundleActionSchema> }>;
  agentKeyCatId?: string;
};

export async function handleTriagePawFeel(input: TriagePawFeelInput): Promise<ToolResult> {
  const { agentKeyCatId, ...command } = input;
  return callbackPost('/api/callbacks/paw-feel-bundle-triage', command, { agentKeyCatId });
}

export const pawFeelDispositionTools = [
  {
    name: 'cat_cafe_capture_paw_feel',
    description:
      'Declare that the current authenticated invocation will include an intentional paw-feel report in its normal final response. ' +
      'Use when: this turn encountered real tool/runtime friction and the final response will contain each intentional marker on its own standalone line. ' +
      'NOT for: supplying symptom prose, copying a marker, agent-key sessions without an invocation, or capturing another cat. Agent-key sessions leave the standalone source marker without calling this tool; bounded append compatibility keeps it visible as ambiguous. ' +
      'Output: a short-lived server-owned intent; after the final response persists, the sidecar binds its generated sourceMessageId and writes confirmed typed rows. ' +
      'GOTCHA: call before the final response; no future message ID or marker body is accepted, and inline/fenced/blockquote examples remain legacy-ambiguous rather than typed-confirmed.',
    inputSchema: capturePawFeelInputSchema,
    handler: handleCapturePawFeel,
  },
  {
    name: 'cat_cafe_list_paw_feel_inbox',
    description:
      'List the F278 responsibility inbox as deterministic contextual review bundles with all raw reports preserved. ' +
      'Use when: you are the named duty cat reviewing original evidence, aging reports, or prior dispositions. ' +
      'NOT for: semantic problem-family counts, copying marker bodies, or treating transport receipt as a fix. ' +
      'Output: bundles, raw occurrences, unique sources, historical/post-activation intake, ambiguity counts, duty evidence, and bundle-level pagination. ' +
      'GOTCHA: problemFamilies is unavailable until an authoritative grouping contract exists.',
    inputSchema: listPawFeelInboxInputSchema,
    handler: handleListPawFeelInbox,
  },
  {
    name: 'cat_cafe_triage_paw_feel',
    description:
      'Confirm one authoritative F278 bundle in O(1) common action plus O(exceptions) member splits. ' +
      'Use when: you reviewed the bundle source evidence and can choose duplicate, reasoned no_action, or fix backed by a real task and active F167 lease. ' +
      'NOT for: routine owner-thread discovery, old routed/closed commands, guessing an owner, or signing your own report terminal. ' +
      'Output: ordered appended/duplicate/conflict/rejected results; partial conflicts stay explicit and retryable. ' +
      'GOTCHA: member IDs and sequences are a snapshot, server membership is revalidated, and late members remain untouched.',
    inputSchema: triagePawFeelInputSchema,
    handler: handleTriagePawFeel,
  },
] as const;
