/**
 * F235 KD-2: GitHub Issue Publisher — raw fetch to REST API.
 *
 * Phase A: bot token from env. Phase B: OAuth user token.
 * Uses existing GITHUB_TOKEN from env-registry (same token
 * used by gh CLI via resolveGhCliToken).
 */

// ── Types ─────────────────────────────────────────────────────

export interface PublishInput {
  readonly repo: string; // 'owner/repo'
  readonly title: string;
  readonly body: string;
  readonly labels: readonly string[];
}

export interface PublishResult {
  readonly issueNumber: number;
  readonly issueUrl: string;
}

export interface IGitHubIssuePublisher {
  publish(input: PublishInput): Promise<PublishResult>;
}

export interface GitHubIssuePublisherConfig {
  /** Static token string, or lazy factory for late-binding (e.g. GitHub plugin config loaded after startup). */
  readonly token: string | (() => string | undefined);
  readonly repoAllowlist: readonly string[];
}

// ── Implementation ────────────────────────────────────────────

export class GitHubIssuePublisher implements IGitHubIssuePublisher {
  private readonly resolveToken: () => string;
  private readonly allowlist: ReadonlySet<string>;

  constructor(config: GitHubIssuePublisherConfig) {
    const { token } = config;
    if (typeof token === 'function') {
      // Lazy factory — resolve at publish time (supports late-binding plugin config)
      this.resolveToken = () => {
        const resolved = token();
        if (!resolved) throw new Error('GITHUB_TOKEN not configured — cannot publish issues');
        return resolved;
      };
    } else {
      if (!token) {
        throw new Error('GITHUB_TOKEN not configured — cannot publish issues');
      }
      this.resolveToken = () => token;
    }
    this.allowlist = new Set(config.repoAllowlist);
  }

  async publish(input: PublishInput): Promise<PublishResult> {
    const token = this.resolveToken();

    // Defense in depth: repo allowlist check (routes also check)
    if (!this.allowlist.has(input.repo)) {
      throw new Error(`Repository ${input.repo} is not in the allowlist. Allowed: ${[...this.allowlist].join(', ')}`);
    }

    const url = `https://api.github.com/repos/${input.repo}/issues`;

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        title: input.title,
        body: input.body,
        labels: [...input.labels],
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      const status = res.status;

      if (status === 401) {
        throw new Error(`GitHub API auth failed (401): ${body}`);
      }
      if (status === 403) {
        throw new Error(`GitHub API permission denied (403): ${body}`);
      }
      if (status === 422) {
        throw new Error(`GitHub API validation error (422): ${body}`);
      }
      throw new Error(`GitHub API error (${status}): ${body}`);
    }

    const data = (await res.json()) as { number: number; html_url: string };

    return {
      issueNumber: data.number,
      issueUrl: data.html_url,
    };
  }
}
