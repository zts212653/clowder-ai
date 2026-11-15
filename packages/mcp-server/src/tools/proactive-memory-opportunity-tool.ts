import {
  type DeferredPersonMemoryClerkDispositionInput,
  deferredPersonMemoryClerkDispositionInputSchema,
} from '@cat-cafe/shared';
import { defineMcpCanonicalFactory } from '../tool-governance-migration.js';

import type { ToolResult } from './file-tools.js';
import { errorResult, successResult } from './file-tools.js';

const defineCanonicalTool = defineMcpCanonicalFactory(
  'proactive-memory-opportunity-tool.ts',
  './tools/callback-tools.js',
  {
    resourceFamily: 'memory-write',
    authority: 'callback-owner',
  },
);

export const deferredPersonMemoryClerkDispositionToolInputSchema =
  deferredPersonMemoryClerkDispositionInputSchema.shape;

type CallbackPost = (path: string, body: Record<string, unknown>) => Promise<ToolResult>;

export function createDeferredPersonMemoryTool(callbackPost: CallbackPost) {
  async function handleDisposeDeferredPersonMemory(
    input: DeferredPersonMemoryClerkDispositionInput,
  ): Promise<ToolResult> {
    const parsed = deferredPersonMemoryClerkDispositionInputSchema.safeParse(input);
    if (!parsed.success) return errorResult('Invalid deferred person-memory clerk disposition input.');
    const result = await callbackPost('/api/callbacks/person-memory/deferred/dispose', parsed.data);
    if (result.isError) return result;
    try {
      const body = JSON.parse(result.content[0]?.text ?? '{}') as Record<string, unknown>;
      if (body.status === 'stale_ignored') {
        return errorResult('Deferred receipt was NOT disposed because this invocation is stale.');
      }
      return successResult(JSON.stringify({ receiptId: body.receiptId, status: body.status }));
    } catch {
      return errorResult('Deferred receipt disposition callback returned an invalid response.');
    }
  }

  return {
    handleDisposeDeferredPersonMemory,
    lifecycleTools: [
      defineCanonicalTool({
        name: 'cat_cafe_dispose_deferred_person_memory',
        description:
          'Close one exact claimed F276 Memory Operations receipt when its bounded sources cannot support a proposal. ' +
          'Use disposition=awaiting_confirmation only when an attachment or ASR source still needs explicit owner confirmation; use insufficient_evidence when the exact sources contain no useful owner-explicit person fact. ' +
          'Pass the exact receiptId and claimId printed in the unified clerk packet. If that packet also prints a writeOpportunityRef, pass its exact triple; the server binds the disposition to the authenticated processor, system thread, invocation, and canonical opportunity generation. ' +
          'This never creates or materializes person memory and never accepts source text, person facts, or aliases.',
        inputSchema: deferredPersonMemoryClerkDispositionToolInputSchema,
        handler: handleDisposeDeferredPersonMemory,
        governance: {
          implementationExport: 'handleDisposeDeferredPersonMemory',
          action: 'close',
          risk: { level: 'write', openWorld: false },
          runtimeProfiles: ['full'],
          standaloneReason: {
            disposition: 'accepted-boundary',
            kind: 'side-effect-boundary',
            admissionRef: 'file:docs/features/F276-people-relationship-memory.md',
          },
        },
      }),
    ],
  };
}
