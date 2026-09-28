import {
  ownerTruthRefV1Schema,
  PAW_FEEL_DISPOSITION_STATES,
  PAW_FEEL_INBOX_SORTS,
  PAW_FEEL_ISSUE_RESOLUTIONS,
  PAW_FEEL_NO_ACTION_REASONS,
} from '@cat-cafe/shared';
import { z } from 'zod';
import { defineMcpCanonicalFactory } from '../tool-governance-migration.js';

import { callbackGet, callbackPost } from './callback-tools.js';
import type { ToolResult } from './file-tools.js';

const defineTool = defineMcpCanonicalFactory('paw-feel-disposition-tools.ts', undefined, {
  resourceFamily: 'eval-feedback',
  authority: 'callback-owner',
});
const repairOutcomeAdmissionReason = {
  disposition: 'accepted-boundary',
  kind: 'authority-boundary',
  admissionRef: 'file:docs/features/F313-analysis-to-outcome-closure-command.md',
} as const;
const legacyCensusAdmissionReason = {
  disposition: 'accepted-boundary',
  kind: 'authority-boundary',
  admissionRef: 'file:docs/features/F313-analysis-to-outcome-closure-command.md',
} as const;

const nonEmpty = z.string().trim().min(1);
const agentKeyCatIdSchema = z
  .string()
  .trim()
  .min(1)
  .optional()
  .describe(
    'Persistent-agent identity selector. Required for shared agent-key MCP variants; ignored under invocation auth.',
  );

const resumeSelectorRefSchema = z.object({ ownerFeatureId: nonEmpty, ownerStateRef: nonEmpty }).strict();
const resumeSelectorSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('task'), ref: resumeSelectorRefSchema }).strict(),
  z.object({ kind: z.literal('owner_event'), ref: resumeSelectorRefSchema }).strict(),
  z.object({ kind: z.literal('bounded_time'), recheckAt: z.string().datetime({ offset: true }) }).strict(),
]);

const terminalActionSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('duplicate'),
      duplicateOf: nonEmpty.describe('Existing canonical signalId that this report duplicates.'),
    })
    .strict(),
  z
    .object({
      type: z.literal('no_action'),
      reasonCode: z.enum(PAW_FEEL_NO_ACTION_REASONS).describe('Canonical reason this report needs no action.'),
    })
    .strict(),
  z
    .object({
      type: z.literal('fix'),
      leaseId: nonEmpty.describe(
        'Active F167 implement/task_done lease whose owner, task, and custody are authoritative.',
      ),
      actionRef: nonEmpty.describe(
        'Opaque action identity consumed only by the provider selected from the verified source tool route.',
      ),
    })
    .strict(),
]);

const bundleActionSchema = z.discriminatedUnion('type', [
  ...terminalActionSchema.options,
  z
    .object({
      type: z.literal('request_signature'),
      action: terminalActionSchema.describe('Exact terminal candidate that an independent cat must sign.'),
      preferredSignerCatId: nonEmpty
        .optional()
        .describe('Optional routing preference; any legal independent signer can recover the request.'),
    })
    .strict(),
  z
    .object({
      type: z.literal('block'),
      blockerCode: nonEmpty.describe('Stable machine-readable blocker category.'),
      blockerRef: nonEmpty.describe('Auditable reference proving the blocker.'),
      resume: resumeSelectorSchema.describe(
        'Canonical task/event selector without a caller version, or a bounded future recheck time.',
      ),
    })
    .strict(),
]);

const bundleMemberSchema = z
  .object({
    signalId: nonEmpty.describe('Exact signalId returned in the listed bundle snapshot.'),
    expectedSequence: z.number().int().nonnegative().describe('CAS sequence returned for this signal.'),
  })
  .strict();

export const listPawFeelInboxInputSchema = {
  states: z.array(z.enum(PAW_FEEL_DISPOSITION_STATES)).min(1).optional().describe('Optional state filter.'),
  sourceCatId: nonEmpty.optional().describe('Optional reporting-cat filter.'),
  sourceMessageId: nonEmpty.optional().describe('Optional exact original-message filter.'),
  overdueOnly: z.boolean().optional().describe('Return only duty-review work without a valid exit at least 72h old.'),
  resolution: z.enum(PAW_FEEL_ISSUE_RESOLUTIONS).optional().describe('Optional open/resolved issue-lifecycle filter.'),
  issueOverdueOnly: z.boolean().optional().describe('Return only unresolved issues at least 72h old.'),
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
  resolution?: (typeof PAW_FEEL_ISSUE_RESOLUTIONS)[number];
  issueOverdueOnly?: boolean;
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
  if (input.resolution) params.resolution = input.resolution;
  if (input.issueOverdueOnly !== undefined) params.issueOverdueOnly = String(input.issueOverdueOnly);
  if (input.limit !== undefined) params.limit = String(input.limit);
  if (input.cursor) params.cursor = input.cursor;
  if (input.sort) params.sort = input.sort;
  return callbackGet('/api/callbacks/paw-feel-inbox', params, {
    agentKeyCatId: input.agentKeyCatId,
  });
}

export const censusLegacyPawFeelBlockersInputSchema = {
  limit: z.number().int().min(1).max(50).optional().describe('Final manifest row limit; defaults to 50.'),
  cursor: z
    .string()
    .trim()
    .min(1)
    .max(100_000)
    .optional()
    .describe('Signed nextCursor from the immediately preceding partial census page.'),
  agentKeyCatId: agentKeyCatIdSchema,
};

export interface CensusLegacyPawFeelBlockersInput {
  limit?: number;
  cursor?: string;
  agentKeyCatId?: string;
}

export async function handleCensusLegacyPawFeelBlockers(input: CensusLegacyPawFeelBlockersInput): Promise<ToolResult> {
  const params: Record<string, string> = {};
  if (input.limit !== undefined) params.limit = String(input.limit);
  if (input.cursor) params.cursor = input.cursor;
  return callbackGet('/api/callbacks/paw-feel-legacy-blocker-census', params, {
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
  membershipToken: nonEmpty.describe('Server-authenticated exact membership snapshot returned with the bundle.'),
  eventIdPrefix: nonEmpty.describe('Stable idempotency prefix for this one bundle confirmation.'),
  members: z
    .array(bundleMemberSchema)
    .min(1)
    .max(50)
    .describe('Exact signalId + sequence snapshot returned in the review bundle.'),
  action: bundleActionSchema.describe(
    'One common terminal action, durable independent-signature request, or explicit blocker.',
  ),
  exceptions: z
    .array(
      z
        .object({
          signalId: nonEmpty.describe('Bundle member whose action differs from the common action.'),
          action: bundleActionSchema.describe('Replacement action for this one member.'),
        })
        .strict(),
    )
    .max(50)
    .optional()
    .describe('Only members whose action differs from the common action. O(exceptions).'),
  agentKeyCatId: agentKeyCatIdSchema,
};

export type TriagePawFeelInput = {
  bundleKey: string;
  membershipToken: string;
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

export const linkPawFeelRepairOutcomeInputSchema = {
  eventId: nonEmpty.describe('Stable idempotency ID for this owner outcome link.'),
  signalId: nonEmpty.describe('Exact F278 signal carrying the prior direct repair binding.'),
  expectedSequence: z.number().int().nonnegative().describe('Current signal CAS sequence.'),
  bindingRef: ownerTruthRefV1Schema.describe('Exact server-derived binding ref returned by F278.'),
  ownerOutcomeRef: ownerTruthRefV1Schema.describe('Opaque canonical outcome ref owned by the selected provider.'),
};

export type LinkPawFeelRepairOutcomeInput = {
  eventId: string;
  signalId: string;
  expectedSequence: number;
  bindingRef: z.infer<typeof ownerTruthRefV1Schema>;
  ownerOutcomeRef: z.infer<typeof ownerTruthRefV1Schema>;
  agentKeyCatId?: string;
};

export async function handleLinkPawFeelRepairOutcome(input: LinkPawFeelRepairOutcomeInput): Promise<ToolResult> {
  const { agentKeyCatId, ...command } = input;
  return callbackPost(
    '/api/callbacks/paw-feel-repair-outcome',
    { ...command, type: 'link_repair_outcome' },
    {
      agentKeyCatId,
    },
  );
}

export const pawFeelDispositionTools = [
  defineTool({
    name: 'cat_cafe_capture_paw_feel',
    description:
      'Declare that the current authenticated invocation will include an intentional paw-feel report in its normal final response. ' +
      'Use when: this turn encountered real tool/runtime friction and the final response will contain each intentional marker on its own standalone line. ' +
      'NOT for: supplying symptom prose, copying a marker, agent-key sessions without an invocation, or capturing another cat. Agent-key sessions leave the standalone source marker without calling this tool; bounded append compatibility keeps it visible as ambiguous. ' +
      'Output: a short-lived server-owned intent; after the final response persists, the sidecar binds its generated sourceMessageId and writes confirmed typed rows. ' +
      'GOTCHA: call before the final response; no future message ID or marker body is accepted, and inline/fenced/blockquote examples remain legacy-ambiguous rather than typed-confirmed.',
    inputSchema: capturePawFeelInputSchema,
    handler: handleCapturePawFeel,
    governance: {
      implementationExport: 'handleCapturePawFeel',
      action: 'create',
      risk: { level: 'write', openWorld: false },
      runtimeProfiles: ['full'],
    },
  }),
  defineTool({
    name: 'cat_cafe_list_paw_feel_inbox',
    description:
      'List the F278 responsibility inbox as deterministic contextual review bundles with all raw reports preserved. ' +
      'Use when: you are the named duty cat reviewing original evidence, aging reports, or prior dispositions. ' +
      'NOT for: semantic problem-family counts, copying marker bodies, or treating transport receipt as a fix. ' +
      'Output: bundles, issue open/resolved/overdue counts, raw occurrences, historical/post-activation intake, duty evidence, and bundle-level pagination. ' +
      'GOTCHA: duty validExit and issue resolution are separate filters; problemFamilies remains unavailable until an authoritative grouping contract exists.',
    inputSchema: listPawFeelInboxInputSchema,
    handler: handleListPawFeelInbox,
    governance: {
      implementationExport: 'handleListPawFeelInbox',
      action: 'read',
      risk: { level: 'read', openWorld: false },
      runtimeProfiles: ['full', 'agent-key'],
    },
  }),
  defineTool({
    name: 'cat_cafe_census_legacy_paw_feel_blockers',
    description:
      'Traverse the authenticated, refs-only F278 legacy blocker census in bounded pages. ' +
      'Use before the separately authorized Phase D historical-blocker recovery terminal. ' +
      'Output: partial pages contain only counts and a signed nextCursor; only a complete traversal returns the deterministic digest-bound manifest. ' +
      'NOT for mutating blockers, reading marker bodies, or treating a partial page as a frozen cohort. ' +
      'GOTCHA: pass each partial nextCursor unchanged and keep the original limit; forged, oversized, or version-drifted cursors fail closed.',
    inputSchema: censusLegacyPawFeelBlockersInputSchema,
    handler: handleCensusLegacyPawFeelBlockers,
    governance: {
      implementationExport: 'handleCensusLegacyPawFeelBlockers',
      action: 'read',
      risk: { level: 'read', openWorld: false },
      runtimeProfiles: ['full', 'agent-key'],
      standaloneReason: legacyCensusAdmissionReason,
    },
  }),
  defineTool({
    name: 'cat_cafe_triage_paw_feel',
    description:
      'Confirm one authoritative F278 bundle in O(1) common action plus O(exceptions) member splits. ' +
      'Use when: you reviewed the bundle source evidence and can choose a terminal action, a verified repair binding, an independent-signature request, or an explicit blocker. ' +
      'NOT for: routine owner-thread discovery, old routed/closed commands, guessing an owner, or signing your own report terminal. ' +
      'Output: ordered appended/duplicate/conflict/rejected/continuation results plus duty-receipt status; authority-required fixes append no fix event and return the existing F266 case continuation. ' +
      'GOTCHA: Task/F167 proves custody, not authority; fix also needs an opaque actionRef validated only by the source-selected provider. Member IDs, sequences, and membershipToken form the exact list snapshot.',
    inputSchema: triagePawFeelInputSchema,
    handler: handleTriagePawFeel,
    governance: {
      implementationExport: 'handleTriagePawFeel',
      action: 'update',
      risk: { level: 'write', openWorld: false },
      runtimeProfiles: ['full', 'agent-key'],
    },
  }),
  defineTool({
    name: 'cat_cafe_link_paw_feel_repair_outcome',
    description:
      'Link a direct paw-feel repair to its canonical owner-verified outcome. ' +
      'Use when: you are the bound repair owner, the exact Task and F167 lease are terminal, and your source-tool provider has a canonical outcome ref. ' +
      'NOT for: sending result payloads, using merge/chat/task-done alone, or substituting a new binding. ' +
      'Output: one refs-only repair_outcome_linked event or a typed rejection; the source resolves only after the server reselects the same provider and verifies terminal truth. ' +
      'GOTCHA: provider route/version drift, a non-owner callback, or a mismatched outcome appends zero events.',
    inputSchema: { ...linkPawFeelRepairOutcomeInputSchema, agentKeyCatId: agentKeyCatIdSchema },
    handler: handleLinkPawFeelRepairOutcome,
    governance: {
      implementationExport: 'handleLinkPawFeelRepairOutcome',
      action: 'update',
      risk: { level: 'write', openWorld: false },
      runtimeProfiles: ['full', 'agent-key'],
      standaloneReason: repairOutcomeAdmissionReason,
    },
  }),
] as const;
