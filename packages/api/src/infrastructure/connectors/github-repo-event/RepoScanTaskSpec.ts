/**
 * F141 Phase B: RepoScanTaskSpec — Reconciliation scanning
 *
 * Queries `gh api` for open PRs/Issues in allowlisted repos, filters via
 * business dedup (KD-15), and delivers missed events through the same
 * deliverConnectorMessage pipeline as Phase A webhooks.
 *
 * Follows F139 TaskSpec_P1 consumer pattern (CiCdCheckTaskSpec etc).
 */
import type { CatId, CommunityEvent, ConnectorSource } from '@cat-cafe/shared';
import type { ICommunityEventLog } from '../../../domains/community/CommunityEventLog.js';
import type {
  ConnectorDeliveryDeps,
  ConnectorDeliveryInput,
  ConnectorDeliveryResult,
} from '../../email/deliver-connector-message.js';
import type { ExecuteContext, GateCtx, TaskSpec_P1, WorkItem } from '../../scheduler/types.js';
import type { IConnectorThreadBindingStore } from '../ConnectorThreadBindingStore.js';
import type { ReconciliationDedup } from './ReconciliationDedup.js';
import type { RepoInboxSignal } from './types.js';

/** Minimal projector interface — only apply() needed here. */
interface ICommunityProjectorApply {
  apply(event: CommunityEvent): Promise<void>;
}

const CONNECTOR_ID = 'github-repo-event';
const DEFAULT_MAX_WORK_ITEMS_PER_RUN = 5;
/** Repo owner's own PRs/issues should not trigger community intake. */
const SKIP_AUTHOR_ASSOCIATIONS = new Set(['OWNER']);

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
  reconciliationDedup: Pick<
    ReconciliationDedup,
    'isNotified' | 'markNotified' | 'isBaselineEstablished' | 'markBaselineEstablished'
  >;
  bindingStore: Pick<IConnectorThreadBindingStore, 'getByExternal'>;
  deliverFn: (deps: ConnectorDeliveryDeps, input: ConnectorDeliveryInput) => Promise<ConnectorDeliveryResult>;
  deliveryDeps: ConnectorDeliveryDeps;
  invokeTrigger: {
    trigger(
      threadId: string,
      catId: CatId,
      userId: string,
      message: string,
      messageId: string,
    ): void | Promise<unknown>;
  };
  fetchOpenPRs: (repo: string) => Promise<GhPrItem[]>;
  fetchOpenIssues: (repo: string) => Promise<GhIssueItem[]>;
  log: { info(...args: unknown[]): void; warn(...args: unknown[]): void };
  pollIntervalMs?: number;
  maxWorkItemsPerRun?: number;
  skipHistoricalOnFirstRun?: boolean;
  /** F202-2B: Override task ID for plugin-scoped schedule instances */
  id?: string;
  // F168 Phase A: community event log + projector (best-effort, optional)
  eventLog?: ICommunityEventLog;
  projector?: ICommunityProjectorApply;
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
  const maxWorkItemsPerRun = Math.max(1, opts.maxWorkItemsPerRun ?? DEFAULT_MAX_WORK_ITEMS_PER_RUN);
  const skipHistoricalOnFirstRun = opts.skipHistoricalOnFirstRun ?? true;
  let nextWorkItemOffset = 0;

  function selectWorkItems(workItems: WorkItem<RepoInboxSignal>[]): WorkItem<RepoInboxSignal>[] {
    if (workItems.length <= maxWorkItemsPerRun) {
      nextWorkItemOffset = 0;
      return workItems;
    }

    const start = nextWorkItemOffset % workItems.length;
    const selected: WorkItem<RepoInboxSignal>[] = [];
    for (let i = 0; i < maxWorkItemsPerRun; i += 1) {
      selected.push(workItems[(start + i) % workItems.length]!);
    }
    nextWorkItemOffset = (start + maxWorkItemsPerRun) % workItems.length;
    return selected;
  }

  return {
    id: opts.id ?? 'repo-scan',
    profile: 'poller',
    trigger: { type: 'interval', ms: opts.pollIntervalMs ?? 300_000 },
    admission: {
      async gate(_ctx: GateCtx) {
        if (opts.repoAllowlist.length === 0) {
          return { run: false, reason: 'no repos in allowlist' };
        }

        const workItems: WorkItem<RepoInboxSignal>[] = [];
        let baselinedItemCount = 0;
        let baselinedRepoCount = 0;

        for (const repo of opts.repoAllowlist) {
          try {
            const repoWorkItems: WorkItem<RepoInboxSignal>[] = [];
            const baselineEstablished =
              !skipHistoricalOnFirstRun || (await opts.reconciliationDedup.isBaselineEstablished(repo));

            const prs = await opts.fetchOpenPRs(repo);
            for (const pr of prs) {
              if (pr.draft) continue;
              if (SKIP_AUTHOR_ASSOCIATIONS.has(pr.author_association)) continue;
              if (await opts.reconciliationDedup.isNotified(repo, 'pr', pr.number)) continue;
              repoWorkItems.push({
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
              if (SKIP_AUTHOR_ASSOCIATIONS.has(issue.author_association)) continue;
              if (await opts.reconciliationDedup.isNotified(repo, 'issue', issue.number)) continue;
              repoWorkItems.push({
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

            if (!baselineEstablished) {
              await Promise.all(
                repoWorkItems.map((item) =>
                  opts.reconciliationDedup.markNotified(
                    item.signal.repoFullName,
                    item.signal.subjectType,
                    item.signal.number,
                  ),
                ),
              );
              await opts.reconciliationDedup.markBaselineEstablished(repo);
              baselinedItemCount += repoWorkItems.length;
              baselinedRepoCount += 1;
              continue;
            }

            workItems.push(...repoWorkItems);
          } catch {
            opts.log.warn(`[repo-scan] Failed to scan ${repo}, skipping`);
          }
        }

        if (workItems.length === 0) {
          if (baselinedRepoCount > 0) {
            return {
              run: false,
              reason: `baseline established for ${baselinedItemCount} existing repo items across ${baselinedRepoCount} repo(s)`,
            };
          }
          return { run: false, reason: 'no unnotified items' };
        }

        return { run: true, workItems: selectWorkItems(workItems) };
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

        // F168 Phase A: emit community event (best-effort — failure never blocks notification)
        if (opts.eventLog) {
          try {
            const kindMap: Record<string, CommunityEvent['kind']> = {
              pr: 'pr.opened',
              issue: 'issue.opened',
            };
            const eventKind = kindMap[signal.subjectType];
            if (eventKind) {
              const subjectKey = `${signal.subjectType}:${signal.repoFullName}#${signal.number}`;
              const sourceEventId = `scan:${signal.repoFullName}:${signal.number}:${eventKind}`;
              const communityEvent: CommunityEvent = {
                sourceEventId,
                subjectKey,
                kind: eventKind,
                classification: 'state-changing',
                payload: { title: signal.title, authorLogin: signal.authorLogin },
                at: Date.now(),
              };
              const { appended } = await opts.eventLog.append(communityEvent);
              if (appended && opts.projector) {
                await opts.projector.apply(communityEvent);
              }
            }
          } catch {
            opts.log.warn(`[repo-scan] community event emit failed for ${signal.repoFullName}#${signal.number}`);
          }
        }

        try {
          void Promise.resolve(
            opts.invokeTrigger.trigger(
              binding.threadId,
              opts.inboxCatId as CatId,
              opts.defaultUserId,
              content,
              delivered.messageId,
            ),
          ).catch(() => opts.log.warn(`[repo-scan] trigger failed for ${signal.repoFullName}#${signal.number}`));
        } catch {
          opts.log.warn(`[repo-scan] trigger failed for ${signal.repoFullName}#${signal.number}`);
        }
      },
    },
    state: { runLedger: 'sqlite' },
    outcome: { whenNoSignal: 'record' },
    enabled: () => opts.repoAllowlist.length > 0,
    actor: { role: 'repo-watcher', costTier: 'cheap' },
    display: {
      label: '仓库巡检',
      category: 'repo',
      description: '补偿扫描：发现 webhook 漏掉的新 PR/Issue',
      subjectKind: 'repo',
    },
  };
}
