import { RUNTIME_QUESTION_RETIREMENT } from '@cat-cafe/shared';
import { z } from 'zod';
import { defineMcpCanonicalFactory } from '../tool-governance-migration.js';
import { callbackPost } from './callback-tools.js';
import { successResult, type ToolResult } from './file-tools.js';

const defineCanonicalTool = defineMcpCanonicalFactory('runtime-interaction-tools.ts', undefined, {
  resourceFamily: 'runtime-interaction',
  authority: 'local-runtime',
});

export const requestUserInputInputSchema = {
  questions: z
    .array(
      z
        .object({
          header: z.string().trim().min(1).max(12).describe('Short header shown above the question (max 12 chars).'),
          question: z.string().trim().min(1).max(500).describe('The user-facing question.'),
          options: z
            .array(
              z
                .object({
                  label: z.string().trim().min(1).max(80).describe('Short user-facing option label.'),
                  description: z
                    .string()
                    .trim()
                    .min(1)
                    .max(300)
                    .optional()
                    .describe('One sentence explaining the option impact or tradeoff.'),
                })
                .strict(),
            )
            .min(2)
            .max(3)
            .describe('Two or three mutually exclusive user-facing choices for this question.'),
        })
        .strict(),
    )
    .min(1)
    .max(3)
    .describe('Legacy input retained for cached callers; questions are not published.'),
};

/** Inert compatibility reply: no HTTP request, credentials, card, or waiter. */
export async function handleRequestUserInput(): Promise<ToolResult> {
  return successResult(JSON.stringify(RUNTIME_QUESTION_RETIREMENT));
}

export const manageConversationDecisionInputSchema = {
  interactionId: z.string().trim().min(1).describe('Exact interactionId from the durable decision receipt or prompt.'),
  expectedRevision: z.number().int().positive().describe('Exact currently observed canonical revision.'),
  operationId: z.string().trim().min(1).max(200).describe('Stable idempotency id for this one transition.'),
  action: z
    .discriminatedUnion('kind', [
      z
        .object({
          kind: z
            .literal('settle_from_message')
            .describe('Settle from the exact owner message that triggered this turn.'),
          responseMessageId: z
            .string()
            .trim()
            .min(1)
            .describe('Exact later owner-authored message in the same thread.'),
        })
        .strict(),
      z
        .object({
          kind: z.literal('withdraw').describe('End this decision because the requester no longer needs an answer.'),
        })
        .strict(),
      z
        .object({
          kind: z.literal('supersede').describe('Replace this decision with a newly published conversation decision.'),
          replacementInteractionId: z.string().trim().min(1).describe('Exact newly published replacement interaction.'),
        })
        .strict(),
    ])
    .describe('One explicit requester-owned lifecycle transition.'),
};

export async function handleManageConversationDecision(input: {
  interactionId: string;
  expectedRevision: number;
  operationId: string;
  action:
    | { kind: 'settle_from_message'; responseMessageId: string }
    | { kind: 'withdraw' }
    | { kind: 'supersede'; replacementInteractionId: string };
}): Promise<ToolResult> {
  return callbackPost('/api/callbacks/runtime-interactions/conversation/manage', input, { enableOutbox: true });
}

export const runtimeInteractionTools = [
  defineCanonicalTool({
    name: 'cat_cafe_manage_conversation_decision',
    description:
      'Settle, withdraw, or supersede one durable conversation decision owned by the authenticated requester cat. ' +
      'Use when: the current owner message clearly answers that named pending question, the requester no longer needs an answer, or it has already published a replacement question. ' +
      'NOT for: creating a decision (use create_rich_block with awaitResponseV1), submitting an owner card response, inferring an answer from arbitrary text, or granting domain approval/Task acceptance. ' +
      'Output: a revision-bound canonical terminal RuntimeInteraction record; settle_from_message references the existing owner message and does not append a second answer turn. ' +
      'GOTCHA: expectedRevision and a stable operationId are mandatory, and settle_from_message accepts only the exact strict-auth owner message that triggered the current requester invocation.',
    inputSchema: manageConversationDecisionInputSchema,
    handler: handleManageConversationDecision,
    governance: {
      implementationExport: 'handleManageConversationDecision',
      action: 'update',
      risk: { level: 'write', openWorld: false },
      runtimeProfiles: ['full'],
      standaloneReason: {
        disposition: 'accepted-boundary',
        kind: 'side-effect-boundary',
        admissionRef: 'file:docs/features/F322-everyday-work-experience.md',
      },
    },
  }),
  defineCanonicalTool({
    name: 'cat_cafe_request_user_input',
    description:
      'Retired blocking question entry; returns an immediate compatibility notice. ' +
      'Use when: an older cached caller references this tool name and needs retirement guidance. ' +
      'NOT for asking questions, permission approval, routine work, or waiting for an owner answer. ' +
      'Output: a retired notice with no card, no waiter, and no approval. Continue already-authorized work; ' +
      'genuine owner decisions or new authorization belong in the existing feature-owned decision surface or current conversation. ' +
      'GOTCHA: do not retry this tool or treat its response as consent. Restricted cloud profiles remain excluded.',
    inputSchema: requestUserInputInputSchema,
    handler: handleRequestUserInput,
    governance: {
      implementationExport: 'handleRequestUserInput',
      action: 'request',
      risk: { level: 'read', openWorld: false },
      runtimeProfiles: ['full'],
      standaloneReason: {
        disposition: 'accepted-boundary',
        kind: 'resource-entry',
        admissionRef: 'file:docs/features/F306-codex-app-capability-parity.md',
      },
    },
  }),
] as const;
