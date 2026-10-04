import type { GitHubReviewThreadBaseline } from '@cat-cafe/shared';
import { executeGitHubRequest, type GitHubRequestOptions } from './request-budget.js';

export async function fetchGitHubReviewThreads(
  repo: string,
  pr: number,
  reviewThreadIds: readonly string[],
  options: GitHubRequestOptions = {},
): Promise<readonly GitHubReviewThreadBaseline[]> {
  const query =
    'query($id:ID!){node(id:$id){... on PullRequestReviewThread{id isResolved pullRequest{number repository{nameWithOwner}} comments(last:1){nodes{id}}}}}';
  const results: GitHubReviewThreadBaseline[] = [];
  // The credential owner already serializes requests. Queueing the whole set
  // would hit its admission cap repeatedly for PRs with many watched threads.
  for (const reviewThreadId of reviewThreadIds) {
    options.signal?.throwIfAborted();
    const { stdout } = await executeGitHubRequest(
      ['api', 'graphql', '-f', `query=${query}`, '-F', `id=${reviewThreadId}`],
      options,
    );
    const node = (
      JSON.parse(stdout) as {
        data?: {
          node?: {
            id?: string;
            isResolved?: boolean;
            pullRequest?: { number?: number; repository?: { nameWithOwner?: string } };
            comments?: { nodes?: Array<{ id?: string }> };
          };
        };
      }
    ).data?.node;
    if (
      !node?.id ||
      node.pullRequest?.number !== pr ||
      node.pullRequest.repository?.nameWithOwner?.toLowerCase() !== repo.toLowerCase()
    ) {
      throw new Error(`Review thread ${reviewThreadId} does not belong to ${repo}#${pr}`);
    }
    results.push({
      reviewThreadId: node.id,
      resolved: node.isResolved === true,
      lastCommentId: node.comments?.nodes?.at(-1)?.id ?? null,
    });
  }
  return results;
}
