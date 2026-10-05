import type { GitHubSnapshot } from '../../domains/community/reconciliation/CommunityReconciler.js';
import type { RepoIssueComment } from '../connectors/github-repo-event/RepoCommentPollTaskSpec.js';
import type { GhIssueItem, GhPrItem } from '../connectors/github-repo-event/RepoScanTaskSpec.js';
import { fetchPaginated } from './fetch-paginated.js';
import { executeGitHubRequest, type GitHubRequestOptions } from './request-budget.js';

type GitHubRepoEntry = Omit<GhPrItem, 'user'> & { user: { login: string }; pull_request?: unknown };
type GitHubRepoComment = {
  issue_url: string;
  id: number;
  user: { login: string };
  author_association: string;
  body: string;
  updated_at: string;
  html_url: string;
};

/** All scheduled repository readers share the same late-bound credential and
 * request owner. Page completion precedes any consumer baseline/cursor commit. */
export function createGitHubRepoPollReaders(options: {
  getGitHubToken: () => string | undefined;
  execFileAsync?: GitHubRequestOptions['execFileAsync'];
}) {
  const requestOptions = (signal?: AbortSignal): GitHubRequestOptions => ({
    ghToken: options.getGitHubToken(),
    signal,
    execFileAsync: options.execFileAsync,
  });
  const list = async (endpoint: string, signal?: AbortSignal): Promise<GitHubRepoEntry[]> =>
    fetchPaginated(endpoint, requestOptions(signal));
  const issueItem = (item: GitHubRepoEntry): GhIssueItem => ({
    number: item.number,
    title: item.title,
    html_url: item.html_url,
    user: item.user.login,
    author_association: item.author_association,
  });
  const subjectState = async (
    repo: string,
    number: number,
    kind: 'issues' | 'pulls',
    signal?: AbortSignal,
  ): Promise<GitHubSnapshot> => {
    const { stdout } = await executeGitHubRequest(['api', `/repos/${repo}/${kind}/${number}`], requestOptions(signal));
    const data = JSON.parse(stdout) as { state?: string; closed_at?: string | null; merged_at?: string | null };
    return {
      state: data.state === 'closed' ? 'closed' : 'open',
      closedAt: data.closed_at ?? null,
      mergedAt: kind === 'pulls' ? (data.merged_at ?? null) : null,
    };
  };
  return {
    async fetchOpenPRs(repo: string, signal?: AbortSignal): Promise<GhPrItem[]> {
      return (await list(`/repos/${repo}/pulls`, signal)).map((item) => ({ ...issueItem(item), draft: item.draft }));
    },
    async fetchOpenIssues(repo: string, signal?: AbortSignal): Promise<GhIssueItem[]> {
      return (await list(`/repos/${repo}/issues`, signal))
        .filter((item) => item.pull_request === undefined || item.pull_request === null)
        .map(issueItem);
    },
    async fetchRepoComments(repo: string, sinceIso?: string, signal?: AbortSignal): Promise<RepoIssueComment[]> {
      const query = new URLSearchParams({ sort: 'updated', direction: 'asc' });
      if (sinceIso) query.set('since', sinceIso);
      const comments = (await fetchPaginated(
        `/repos/${repo}/issues/comments?${query}`,
        requestOptions(signal),
      )) as GitHubRepoComment[];
      return comments.map((comment) => ({
        issueNumber: Number(comment.issue_url.split('/').at(-1)),
        commentId: comment.id,
        author: comment.user.login,
        authorAssociation: comment.author_association,
        body: comment.body,
        updatedAt: comment.updated_at,
        isPullRequest: comment.html_url.includes('/pull/'),
      }));
    },
    fetchIssueState: (repo: string, number: number, signal?: AbortSignal) =>
      subjectState(repo, number, 'issues', signal),
    fetchPrState: (repo: string, number: number, signal?: AbortSignal) => subjectState(repo, number, 'pulls', signal),
  };
}
