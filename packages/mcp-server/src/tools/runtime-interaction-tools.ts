import { RUNTIME_QUESTION_RETIREMENT } from '@cat-cafe/shared';
import { z } from 'zod';
import { defineMcpCanonicalFactory } from '../tool-governance-migration.js';
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

export const runtimeInteractionTools = [
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
