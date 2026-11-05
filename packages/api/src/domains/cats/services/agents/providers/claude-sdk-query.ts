import type { ClaudeSdkQueryFn } from './ClaudeSdkAgentService.js';

/** Keep the SDK/native binding outside API startup when this carrier is unused.
 * ESM owns module caching; no parallel service or query lifecycle is introduced.
 */
export async function loadClaudeSdkQuery(
  signal: AbortSignal,
  load: () => Promise<{ query: ClaudeSdkQueryFn }> = () => import('@anthropic-ai/claude-agent-sdk'),
): Promise<ClaudeSdkQueryFn | undefined> {
  if (signal.aborted) return undefined;
  const sdk = await load();
  return signal.aborted ? undefined : sdk.query;
}
