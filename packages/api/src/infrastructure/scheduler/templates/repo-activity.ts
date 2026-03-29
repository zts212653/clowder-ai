import type { TaskSpec_P1 } from '../types.js';
import type { DynamicTaskParams, TaskTemplate } from './types.js';

/** Repo activity template — watch a GitHub repo for new issues/PRs */
export const repoActivityTemplate: TaskTemplate = {
  templateId: 'repo-activity',
  label: '仓库动态',
  category: 'repo',
  description: '监控 GitHub 仓库的新 Issue 和 PR',
  subjectKind: 'repo',
  defaultTrigger: { type: 'interval', ms: 3600_000 },
  paramSchema: {
    repo: { type: 'string', required: true, description: 'GitHub 仓库全名 (owner/repo)' },
  },
  createSpec(instanceId: string, p: DynamicTaskParams): TaskSpec_P1 {
    const repo = (p.params.repo as string) || '';
    const threadId = p.deliveryThreadId;
    return {
      id: instanceId,
      profile: 'poller',
      trigger: p.trigger,
      admission: {
        async gate(gateCtx) {
          if (!repo) return { run: false, reason: 'no repo param' };
          if (!threadId) return { run: false, reason: 'no deliveryThreadId' };
          const since = gateCtx.lastRunAt ? new Date(gateCtx.lastRunAt).toISOString() : null;
          return {
            run: true,
            workItems: [{ signal: { repo, since }, subjectKey: `thread-${threadId}` }],
          };
        },
      },
      run: {
        overlap: 'skip',
        timeoutMs: 60_000,
        async execute(signal, subjectKey, ctx) {
          if (!ctx.deliver) throw new Error('deliver not available');
          const tid = subjectKey.startsWith('thread-') ? subjectKey.slice(7) : subjectKey;
          const { repo: repoName, since } = signal as { repo: string; since: string | null };

          // Query GitHub REST API for recent issues + PRs
          const params = new URLSearchParams({
            state: 'all',
            per_page: '10',
            sort: 'created',
            direction: 'desc',
          });
          if (since) params.set('since', since);
          const apiUrl = `https://api.github.com/repos/${repoName}/issues?${params}`;
          const headers: Record<string, string> = { 'User-Agent': 'CatCafe-RepoActivity/1.0' };
          if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;

          const res = await fetch(apiUrl, { headers, signal: AbortSignal.timeout(15_000) });
          if (!res.ok) throw new Error(`GitHub API error: ${res.status} ${res.statusText}`);

          type GHIssue = {
            number: number;
            title: string;
            html_url: string;
            pull_request?: unknown;
            user?: { login: string };
          };
          const items = (await res.json()) as GHIssue[];

          let content: string;
          if (items.length === 0) {
            const sinceNote = since ? ` since ${since}` : '';
            content = `## ${repoName}\n\nNo new issues or PRs${sinceNote}.`;
          } else {
            const lines = items.map((item) => {
              const kind = item.pull_request ? 'PR' : 'Issue';
              const by = item.user?.login ? ` by @${item.user.login}` : '';
              return `- **${kind} #${item.number}**: ${item.title}${by}`;
            });
            content = `## ${repoName} Activity\n\n${lines.join('\n')}`;
          }

          await ctx.deliver({
            threadId: tid,
            content,
            catId: ctx.assignedCatId ?? 'system',
            userId: 'scheduler',
          });
        },
      },
      state: { runLedger: 'sqlite' },
      outcome: { whenNoSignal: 'drop' },
      enabled: () => true,
      display: {
        label: repo ? `${repo} 动态` : '仓库动态',
        category: 'repo',
        description: `监控 ${repo} 的新 Issue/PR`,
        subjectKind: 'repo',
      },
    };
  },
};
