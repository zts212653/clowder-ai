import { z } from 'zod';
import { defineMcpMigrationFactory } from '../tool-governance-migration.js';

import { callbackPost } from './callback-tools.js';
import type { ToolResult } from './file-tools.js';

const defineTool = defineMcpMigrationFactory('community-route-acceptance-tool.ts', undefined, {
  resourceFamily: 'community-case',
  authority: 'assigned-callback',
});

export const communityRouteAcceptanceInputSchema = {
  issueId: z
    .string()
    .trim()
    .min(1)
    .max(128)
    .describe('Canonical F168 community issue case id returned by the intake/triage surface.'),
  decision: z.enum(['accept', 'reject']).describe('Assigned-cat route decision for the pending case.'),
  reason: z
    .string()
    .trim()
    .min(1)
    .max(2000)
    .optional()
    .describe('Concise evidence-based reason for accepting or rejecting the route.'),
};

export async function handleCommunityRouteAcceptance(input: {
  issueId: string;
  decision: 'accept' | 'reject';
  reason?: string;
}): Promise<ToolResult> {
  return callbackPost(`/api/community-issues/${encodeURIComponent(input.issueId)}/validate-route`, {
    decision: input.decision,
    ...(input.reason ? { reason: input.reason } : {}),
  });
}

export const communityRouteAcceptanceTools = [
  defineTool({
    name: 'cat_cafe_validate_community_route',
    description:
      'Accept or reject an F168 auto-routed community issue as the assigned cat. ' +
      'Use when: narrator/triage has assigned the current cat a real case with routeAcceptance=pending and the cat has independently verified the thread and custody. ' +
      'NOT for: triage, assigning another cat, operator owner decisions, changing a non-pending case, or bypassing external-author custody. ' +
      'Output: returns the canonical CommunityIssueItem after the route state transition; reject clears assignment and returns the case to pending-decision. ' +
      'GOTCHA: callback identity is supplied inside the MCP bridge—the API verifies that the caller is the assigned cat. Never copy callback credentials into shell commands or tool arguments.',
    inputSchema: communityRouteAcceptanceInputSchema,
    handler: handleCommunityRouteAcceptance,
    governance: {
      implementationExport: 'handleCommunityRouteAcceptance',
      action: 'validate',
      risk: { level: 'write', openWorld: false },
      runtimeProfiles: ['full'],
    },
  }),
] as const;
