import { randomUUID } from 'node:crypto';
import {
  candidateInteractionDraftSchema,
  interactionEventIdSchema,
  materializableClaimPayloadSchema,
  personClaimIdSchema,
  personIdSchema,
} from '@cat-cafe/shared';
import { z } from 'zod';
import { bindMcpImplementation, defineMcpTool } from '../tool-governance.js';
import { errorResult, type ToolResult } from './file-tools.js';

const sourceMutation = {
  personId: personIdSchema.describe('Exact active private person ID from an authorized relationship card.'),
  sourceMessageId: z
    .string()
    .trim()
    .min(1)
    .max(240)
    .optional()
    .describe('Optional assertion; when supplied it must equal the authenticated invocation origin.'),
  clientRequestId: z.string().trim().min(1).max(200).optional().describe('Stable request key; reuse it when retrying.'),
};
const correctClaim = z
  .object({
    ...sourceMutation,
    action: z.literal('correct_claim'),
    expectedCurrentClaimId: personClaimIdSchema.describe('Exact current claim anchor; stale anchors are rejected.'),
    payload: materializableClaimPayloadSchema.describe(
      'Replacement owner fact or assessment; agent inference is rejected.',
    ),
  })
  .strict();
const retireClaim = z
  .object({
    ...sourceMutation,
    action: z.literal('retire_claim'),
    expectedCurrentClaimId: correctClaim.shape.expectedCurrentClaimId,
  })
  .strict();
const amendEvent = z
  .object({
    ...sourceMutation,
    action: z.literal('amend_event'),
    expectedEventId: interactionEventIdSchema.describe('Exact source event anchor; the original is never overwritten.'),
    payload: candidateInteractionDraftSchema.shape.payload.describe(
      'Replacement event projection; preserve approximate or conflicting time.',
    ),
  })
  .strict();
const requestSchema = z.discriminatedUnion('action', [correctClaim, retireClaim, amendEvent]);
type PersonRevisionInput = z.infer<typeof requestSchema>;

const routes = {
  correct_claim: { path: 'correct-claim', prefix: 'correction_' },
  retire_claim: { path: 'retire-claim', prefix: 'retirement_' },
  amend_event: { path: 'amend-event', prefix: 'amendment_' },
} as const;
const sourceRef = 'file:packages/mcp-server/src/tools/person-memory-revision-tool.ts' as const;
const boundary = {
  risk: { level: 'write', openWorld: false },
  authorizationPaths: [
    {
      principal: 'invocation-cat',
      credentialSource: 'invocation-record',
      scope: { kind: 'owner-private' },
      enforcementRef: 'file:packages/api/src/routes/callback-person-memory-routes.ts',
    },
  ],
} as const;

export function createPersonMemoryRevisionTool(
  callbackPost: (path: string, body: Record<string, unknown>) => Promise<ToolResult>,
) {
  async function handleRevisePersonMemory(input: PersonRevisionInput): Promise<ToolResult> {
    const parsed = requestSchema.safeParse(input);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return errorResult(`Invalid person revision ${issue?.path.join('.') || 'input'}: ${issue?.message}`);
    }
    const { action, clientRequestId, ...body } = parsed.data;
    const route = routes[action];
    return callbackPost(`/api/callbacks/person-memory/${route.path}`, {
      ...body,
      requestId: clientRequestId ?? `${route.prefix}${randomUUID()}`,
    });
  }

  return {
    handleRevisePersonMemory,
    tool: defineMcpTool({
      name: 'cat_cafe_revise_person_memory',
      description:
        'Revise one owner-private claim or interaction. ' +
        'Use when: the owner corrects a fact (correct_claim), retires a claim (retire_claim), or amends an event (amend_event). ' +
        'NOT for: new proposals, recall, or permanent forgetting. ' +
        'Output: an append-only revision and lifecycle result. ' +
        'GOTCHA: pass the exact current anchor; the server verifies owner source and rejects stale anchors.',
      operation: {
        kind: 'discriminated',
        discriminator: 'action',
        variants: [
          { action: 'correct_claim', inputSchema: correctClaim.shape, boundary },
          { action: 'retire_claim', inputSchema: retireClaim.shape, boundary },
          { action: 'amend_event', inputSchema: amendEvent.shape, boundary },
        ],
      },
      implementation: bindMcpImplementation(
        'module:./tools/callback-tools.js#handleRevisePersonMemory',
        handleRevisePersonMemory,
      ),
      policy: {
        resourceFamily: 'person-memory',
        runtimeProfiles: ['full'],
        activeState: 'canonical',
        schemaDelivery: { policy: 'host-default', evidenceRef: sourceRef },
        owner: { domainCell: 'architecture-cell:memory', surface: 'mcp-surface-governance' },
        standaloneReason: {
          disposition: 'accepted-boundary',
          kind: 'side-effect-boundary',
          admissionRef: 'file:docs/features/F332-experience-informed-memory.md',
        },
        cognitiveEntryPoints: [{ kind: 'tool-description', ref: sourceRef }],
        verification: [{ kind: 'test', ref: 'test:packages/mcp-server/test/memory-entry-contracts.test.js' }],
      },
    }),
  };
}
