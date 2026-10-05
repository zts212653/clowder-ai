import {
  executeGitHubRequest,
  GitHubRateLimitError,
  type GitHubRequestOptions,
  gitHubCredentialKey,
} from './request-budget.js';

const createdTimes = new Map<string, string>();

/** Comment IDs are the durable cursor. The timestamp is only a safe API lower
 * bound; use immutable created_at (not updated_at), include a one-second overlap,
 * and retain the final id filter. Missing/deleted cursor objects replay safely. */
export async function commentSince(
  endpoint: string,
  cursor: number,
  options: GitHubRequestOptions,
): Promise<string | undefined> {
  const match = endpoint.match(/^(\/repos\/[^/]+\/[^/]+\/(?:issues|pulls))\/\d+\/comments$/);
  if (!match || cursor <= 0) return undefined;
  const key = `${await gitHubCredentialKey(options.ghToken)}:${endpoint}:${cursor}`;
  const cached = createdTimes.get(key);
  if (cached) return cached;
  try {
    const { stdout } = await executeGitHubRequest(['api', `${match[1]}/comments/${cursor}`], options);
    const comment: unknown = JSON.parse(stdout);
    if (
      !comment ||
      typeof comment !== 'object' ||
      !('created_at' in comment) ||
      !('id' in comment) ||
      comment.id !== cursor ||
      typeof comment.created_at !== 'string'
    )
      return undefined;
    const timestamp = Date.parse(comment.created_at);
    if (!Number.isFinite(timestamp)) return undefined;
    const since = new Date(timestamp - 1000).toISOString();
    createdTimes.set(key, since);
    if (createdTimes.size > 2048) createdTimes.delete(createdTimes.keys().next().value!);
    return since;
  } catch (error) {
    options.signal?.throwIfAborted();
    if (error instanceof GitHubRateLimitError) throw error;
    // Only a missing/deleted cursor may fall back; transport/auth failures must
    // not amplify themselves into a full historical scan.
    if (/404|Not Found/i.test(error instanceof Error ? error.message : String(error))) return undefined;
    throw error;
  }
}
