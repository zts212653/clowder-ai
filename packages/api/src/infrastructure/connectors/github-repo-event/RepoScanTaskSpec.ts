/**
 * F141 Phase B: RepoScanTaskSpec — Reconciliation scanning
 *
 * Queries `gh api` for open PRs/Issues in allowlisted repos, filters via
 * business dedup (KD-15), and delivers missed events through the same
 * deliverConnectorMessage pipeline as Phase A webhooks.
 *
 * Follows F139 TaskSpec_P1 consumer pattern (CiCdCheckTaskSpec etc).
 */
import type { CatId, ConnectorSource } from '@cat-cafe/shared';
import type {
  ConnectorDeliveryDeps,
  ConnectorDeliveryInput,
  ConnectorDeliveryResult,
} from '../../email/deliver-connector-message.js';
import type { ExecuteContext, TaskSpec_P1 } from '../../scheduler/types.js';
import type { IConnectorThreadBindingStore } from '../ConnectorThreadBindingStore.js';
import type { ReconciliationDedup } from './ReconciliationDedup.js';
import type { RepoInboxSignal } from './types.js';

const CONNECTOR_ID = 'github-repo-event';

export interface GhPrItem {
  number: number;
  title: string;
  html_url: string;
  user: string;
  author_association: string;
  draft: boolean;
}

export interface GhIssueItem {
  number: number;
  title: string;
  html_url: string;
  user: string;
  author_association: string;
}

export interface RepoScanTaskSpecOptions {
  repoAllowlist: string[];
  inboxCatId: string;
  defaultUserId: string;
  reconciliationDedup: Pick<ReconciliationDedup, 'isNotified' | 'markNotified'>;
  bindingStore: Pick<IConnectorThreadBindingStore, 'getByExternal'>;
  deliverFn: (deps: ConnectorDeliveryDeps, input: ConnectorDeliveryInput) => Promise<ConnectorDeliveryResult>;
  deliveryDeps: ConnectorDeliveryDeps;
  invokeTrigger: {
    trigger(threadId: string, catId: CatId, userId: string, message: string, messageId: string): void;
  };
  fetchOpenPRs: (repo: string) => Promise<GhPrItem[]>;
  fetchOpenIssues: (repo: string) => Promise<GhIssueItem[]>;
  log: { info(...args: unknown[]): void; warn(...args: unknown[]): void };
  pollIntervalMs?: number;
}

function formatReconciliationMessage(signal: RepoInboxSignal): string {
  const typeEmoji = signal.subjectType === 'pr' ? '\u{1F500}' : '\u{1F195}';
  return [
    `${typeEmoji} **${signal.subjectType === 'pr' ? 'PR' : 'Issue'} #${signal.number}** (reconciliation)`,
    `**${signal.title}**`,
    `by \`${signal.authorLogin}\` (${signal.authorAssociation}) in \`${signal.repoFullName}\``,
    signal.url,
  ].join('\n');
}

export function createRepoScanTaskSpec(opts: RepoScanTaskSpecOptions): TaskSpec_P1<RepoInboxSignal> {
  return {
    id: 'repo-scan',
    profile: 'poller',
    trigger: { type: 'interval', ms: opts.pollIntervalMs ?? 300_000 },
    admission: {
      async gate() {
        if (opts.repoAllowlist.length === 0) {
          return { run: false, reason: 'no repos in allowlist' };
        }

        const workItems: { signal: RepoInboxSignal; subjectKey: string }[] = [];

        for (const repo of opts.repoAllowlist) {
          try {
            const prs = await opts.fetchOpenPRs(repo);
            for (const pr of prs) {
              if (pr.draft) continue;
              if (await opts.reconciliationDedup.isNotified(repo, 'pr', pr.number)) continue;
              workItems.push({
                signal: {
                  eventType: 'pull_request.opened',
                  repoFullName: repo,
                  subjectType: 'pr',
                  number: pr.number,
                  title: pr.title,
                  url: pr.html_url,
                  authorLogin: pr.user,
                  authorAssociation: pr.author_association,
                  deliveryId: `reconciliation-pr-${repo}#${pr.number}`,
                  action: 'opened',
                },
                subjectKey: `repo-${repo}#pr-${pr.number}`,
              });
            }

            const issues = await opts.fetchOpenIssues(repo);
            for (const issue of issues) {
              if (await opts.reconciliationDedup.isNotified(repo, 'issue', issue.number)) continue;
              workItems.push({
                signal: {
                  eventType: 'issues.opened',
                  repoFullName: repo,
                  subjectType: 'issue',
                  number: issue.number,
                  title: issue.title,
                  url: issue.html_url,
                  authorLogin: issue.user,
                  authorAssociation: issue.author_association,
                  deliveryId: `reconciliation-issue-${repo}#${issue.number}`,
                  action: 'opened',
                },
                subjectKey: `repo-${repo}#issue-${issue.number}`,
              });
            }
          } catch {
            opts.log.warn(`[repo-scan] Failed to scan ${repo}, skipping`);
          }
        }

        if (workItems.length === 0) {
          return { run: false, reason: 'no unnotified items' };
        }
        return { run: true, workItems };
      },
    },
    run: {
      overlap: 'skip',
      timeoutMs: 30_000,
      async execute(signal: RepoInboxSignal, _subjectKey: string, _ctx: ExecuteContext) {
        const binding = await opts.bindingStore.getByExternal(CONNECTOR_ID, signal.repoFullName);
        if (!binding) {
          opts.log.warn(`[repo-scan] No inbox thread for ${signal.repoFullName}, skipping`);
          return;
        }

        const content = formatReconciliationMessage(signal);
        const source: ConnectorSource = {
          connector: CONNECTOR_ID,
          label: 'Repo Inbox (reconciliation)',
          icon: 'github',
          url: signal.url,
          meta: {
            repoFullName: signal.repoFullName,
            subjectType: signal.subjectType,
            number: signal.number,
            action: signal.action,
            deliveryId: signal.deliveryId,
            authorAssociation: signal.authorAssociation,
          },
          sender: { id: signal.authorLogin, name: signal.authorLogin },
        };

        const delivered = await opts.deliverFn(opts.deliveryDeps, {
          threadId: binding.threadId,
          userId: opts.defaultUserId,
          catId: opts.inboxCatId,
          content,
          source,
        });

        await opts.reconciliationDedup.markNotified(signal.repoFullName, signal.subjectType, signal.number);

        try {
          opts.invokeTrigger.trigger(
            binding.threadId,
            opts.inboxCatId as CatId,
            opts.defaultUserId,
            content,
            delivered.messageId,
          );
        } catch {
          opts.log.warn(`[repo-scan] trigger failed for ${signal.repoFullName}#${signal.number}`);
        }
      },
    },
    state: { runLedger: 'sqlite' },
    outcome: { whenNoSignal: 'record' },
    enabled: () => opts.repoAllowlist.length > 0,
    actor: { role: 'repo-watcher', costTier: 'cheap' },
  };
}
