import { type ProactiveMemoryAbstentionInput, proactiveMemoryAbstentionInputSchema } from '@cat-cafe/shared';
import { defineMcpMigrationFactory } from '../tool-governance-migration.js';

import type { ToolResult } from './file-tools.js';
import { errorResult, successResult } from './file-tools.js';

const defineTool = defineMcpMigrationFactory('proactive-memory-opportunity-tool.ts', undefined, {
  resourceFamily: 'memory-write',
  authority: 'callback-owner',
});

export const proactiveMemoryAbstentionToolInputSchema = proactiveMemoryAbstentionInputSchema.shape;

export async function handleRecordProactiveMemoryAbstention(
  input: ProactiveMemoryAbstentionInput,
): Promise<ToolResult> {
  const parsed = proactiveMemoryAbstentionInputSchema.safeParse(input);
  if (!parsed.success) {
    return errorResult('Invalid proactive-memory abstention reason.');
  }
  return successResult(JSON.stringify({ status: 'recorded' }));
}

export const proactiveMemoryOpportunityTool = defineTool({
  name: 'cat_cafe_record_proactive_memory_abstention',
  description:
    'Record why you deliberately did not create an F276 person-memory proposal for the current proactive-memory opportunity. ' +
    'Use only after applying the proactive-memory-judgment gates and deciding to abstain. ' +
    'Input is one bounded enum reason; the server derives the current invocation opportunity and never accepts an opportunity, message, thread, owner, or person coordinate from the caller. ' +
    'NOT for proposal failures that you still intend to retry, or for recording a proposal success (use cat_cafe_propose_person_memory). ' +
    'Output is a content-free local receipt used only for the incubating F282 cold-start evaluation.',
  inputSchema: proactiveMemoryAbstentionToolInputSchema,
  handler: handleRecordProactiveMemoryAbstention,
  governance: {
    implementationExport: 'handleRecordProactiveMemoryAbstention',
    action: 'update',
    risk: { level: 'write', openWorld: false },
    runtimeProfiles: ['full'],
  },
});
