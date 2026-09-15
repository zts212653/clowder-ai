/**
 * Home-State Tools — F300 M3 pull snapshot.
 *
 * The cat's own coordinates, read from the same API the Console reads. There is
 * deliberately no second computation here: if this tool derived the answer
 * itself, "what the cat believes" and "what the user sees" would drift, which is
 * the exact failure F300 exists to remove.
 */

import { z } from 'zod';
import { defineMcpCanonicalFactory } from '../tool-governance-migration.js';
import { buildAuthHeaders, getCallbackConfig } from './callback-tools.js';
import { errorResult, successResult, type ToolResult } from './file-tools.js';

const defineTool = defineMcpCanonicalFactory('home-state-tools.ts', undefined, {
  resourceFamily: 'home-state',
  authority: 'local-runtime',
});

/**
 * Home state is self-knowledge, not runtime control: it reads and never mutates,
 * so folding it into the `runtime-control` family would put a safe read behind a
 * destructive family's boundary and blur what each family means.
 */
const admissionReason = {
  disposition: 'accepted-boundary' as const,
  kind: 'resource-entry' as const,
  admissionRef: 'file:docs/features/F300-self-sensing-home-state-awareness.md' as const,
};

const API_URL = process.env['CAT_CAFE_API_URL'] ?? 'http://localhost:3004';
const TIMEOUT_MS = 5_000;

/**
 * No caller identity parameters: who is asking is proven by the invocation
 * credentials, not asserted in the arguments. A `catId` argument would be a
 * request to be told about someone else while calling it "self".
 */
export const homeStateSelfInputSchema = {};

export async function handleHomeStateSelf(_input: Record<string, never> = {}): Promise<ToolResult> {
  const url = `${API_URL}/api/home-state/self`;
  const config = getCallbackConfig();
  if (!config) {
    return errorResult(
      "Home state needs this invocation's credentials to know which cat is asking, and none are available. " +
        'That is itself a fact about this home: this process cannot prove who it is.',
    );
  }

  try {
    const response = await fetch(url, {
      headers: buildAuthHeaders(config),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) {
      return errorResult(
        `Home state unavailable: HTTP ${response.status} from ${url}. ` +
          'That is itself a fact about this home: the API that would answer is not answering.',
      );
    }
    return successResult(JSON.stringify(await response.json(), null, 2));
  } catch (error) {
    // Not reaching the owner is a typed outcome, not an empty answer: a cat that
    // cannot read its own coordinates must not proceed as if it had.
    return errorResult(
      `Home state owner unreachable at ${url}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export const homeStateTools = [
  defineTool({
    name: 'cat_cafe_home_state_self',
    description:
      'Return where this cat is running: installation, worktree and HEAD, platform, the api/redis processes it is running inside of, its thread/invocation coordinates, and its quota pool status. ' +
      'Use when: about to do something with side effects and you need to know what it would touch; explaining a runtime problem without asking the user for repo or log paths; checking whether your own budget is exhausted. ' +
      "Not for: reading another cat's or another deployment's state, changing anything, or as a health dashboard (that is the Console). " +
      'Output: a refs-only JSON facet for the calling cat, built fresh per call and never stored. It takes no arguments: which cat is asking comes from this invocation, not from a parameter. ' +
      'GOTCHA: missing facts come back typed (unknown / stale / owner_unreachable) and none of them mean "safe to proceed" — quota "unknown" is not "quota fine".',
    inputSchema: homeStateSelfInputSchema,
    handler: handleHomeStateSelf,
    governance: {
      implementationExport: 'handleHomeStateSelf',
      action: 'read',
      risk: { level: 'read', openWorld: false },
      runtimeProfiles: ['full', 'readonly'],
      standaloneReason: admissionReason,
    },
  }),
] as const;
