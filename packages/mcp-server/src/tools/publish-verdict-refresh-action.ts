import { z } from 'zod';
import { callbackPost } from './callback-tools.js';
import type { ToolResult } from './file-tools.js';

const PUBLISH_VERDICT_FETCH_TIMEOUT_MS = 120_000;

export const publishVerdictRefreshActionShape = z
  .object({
    kind: z.literal('refresh_pr'),
    verdictId: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
    expectedHeadSha: z.string().regex(/^[a-f0-9]{40}$/),
  })
  .describe(
    'Lifecycle transition for an already-open auto-verdict PR. refresh_pr exact-head rebases onto latest main and recomputes only the derived measurement census.',
  );

export type PublishVerdictRefreshAction = z.infer<typeof publishVerdictRefreshActionShape>;

export function validatePublishVerdictLifecycleInput(input: {
  action?: PublishVerdictRefreshAction;
  packet?: unknown;
  sourceRefs?: unknown;
}): string | null {
  const hasRefresh = input.action?.kind === 'refresh_pr';
  const hasPublish = input.packet !== undefined || input.sourceRefs !== undefined;
  if (hasRefresh === hasPublish || (!hasRefresh && (input.packet === undefined || input.sourceRefs === undefined))) {
    return 'Error: provide exactly one lifecycle form: packet + sourceRefs for initial publish, or action.kind=refresh_pr for an existing auto-verdict PR.';
  }
  return null;
}

export function handleRefreshVerdictAction(input: {
  domainId: string;
  action: PublishVerdictRefreshAction;
  agentKeyCatId?: string;
}): Promise<ToolResult> {
  return callbackPost(
    `/api/eval-domains/${encodeURIComponent(input.domainId)}/publish-verdict/refresh`,
    {
      verdictId: input.action.verdictId,
      expectedHeadSha: input.action.expectedHeadSha,
    },
    {
      agentKeyCatId: input.agentKeyCatId,
      retryDelaysMs: [],
      fetchTimeoutMs: PUBLISH_VERDICT_FETCH_TIMEOUT_MS,
    },
  );
}
