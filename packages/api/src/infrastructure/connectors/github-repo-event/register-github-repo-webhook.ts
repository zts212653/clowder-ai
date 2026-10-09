/** Existing Repo Inbox wiring, separated from the IM gateway until W3 replacement. */
import type { RedisClient } from '@cat-cafe/shared/utils';
import type { FastifyBaseLogger } from 'fastify';
import type { ConnectorWebhookHandler } from '../../../routes/connector-webhooks.js';
import { type ConnectorDeliveryDeps, deliverConnectorMessage } from '../../email/deliver-connector-message.js';
import { type GitHubRepoHandlerDeps, GitHubRepoWebhookHandler } from './GitHubRepoWebhookHandler.js';
import { ReconciliationDedup } from './ReconciliationDedup.js';
import { RedisDeliveryDedup } from './RedisDeliveryDedup.js';
import { createRepoInboxOwnerResolver, type RepoInboxOwnerConfigStore } from './RepoInboxOwnerResolver.js';

interface RepoWebhookDeps {
  readonly redis?: RedisClient | undefined;
  readonly log: FastifyBaseLogger;
  readonly defaultUserId: string;
  readonly bindingStore: GitHubRepoHandlerDeps['bindingStore'];
  readonly threadStore: GitHubRepoHandlerDeps['threadStore'];
  readonly invokeTrigger: GitHubRepoHandlerDeps['invokeTrigger'];
  readonly deliveryDeps: ConnectorDeliveryDeps;
  readonly repoConfigStore?: RepoInboxOwnerConfigStore | undefined;
  readonly classifyGitHubIssueComment?: GitHubRepoHandlerDeps['classifyIssueComment'];
}

export async function registerGitHubRepoWebhook(
  webhookHandlers: Map<string, ConnectorWebhookHandler>,
  deps: RepoWebhookDeps,
): Promise<void> {
  const { log, bindingStore, defaultUserId: effectiveUserId } = deps;
  // ── F141: GitHub Repo Inbox webhook handler (not an IM connector) ──
  const ghWebhookSecret = process.env.GITHUB_WEBHOOK_SECRET;
  const ghRepoAllowlist = process.env.GITHUB_REPO_ALLOWLIST;
  const ghInboxCatId = process.env.GITHUB_REPO_INBOX_CAT_ID;

  if (ghWebhookSecret && ghRepoAllowlist && ghInboxCatId && deps.redis) {
    const ghDedup = new RedisDeliveryDedup(deps.redis as import('./RedisDeliveryDedup.js').RedisLike);
    const ghReconciliationDedup = new ReconciliationDedup(
      deps.redis as import('./ReconciliationDedup.js').ReconciliationRedisLike,
    );

    // F168 Phase A P1-1b: create community event services from deps.redis for webhook handler
    let ghEventLog: import('../../../domains/community/CommunityEventLog.js').ICommunityEventLog | undefined;
    let ghProjector: { apply(event: unknown): Promise<void> } | undefined;
    try {
      const [elMod, osMod, pjMod] = await Promise.all([
        import('../../../domains/community/CommunityEventLog.js'),
        import('../../../domains/community/CommunityObjectStore.js'),
        import('../../../domains/community/community-projector.js'),
      ]);
      const ghObjectStore = new osMod.RedisCommunityObjectStore(deps.redis);
      ghEventLog = new elMod.RedisCommunityEventLog(deps.redis);
      ghProjector = new pjMod.CommunityProjector(ghEventLog, ghObjectStore);
    } catch (err) {
      log.warn({ err }, '[F168] Failed to initialize community event services for webhook handler — events disabled');
    }

    const ghHandler = new GitHubRepoWebhookHandler(
      {
        webhookSecret: ghWebhookSecret,
        repoAllowlist: ghRepoAllowlist.split(',').map((r) => r.trim()),
        inboxCatId: ghInboxCatId,
        defaultUserId: effectiveUserId,
      },
      {
        bindingStore,
        threadStore: deps.threadStore,
        deliverFn: deliverConnectorMessage,
        invokeTrigger: deps.invokeTrigger,
        dedup: ghDedup,
        reconciliationDedup: ghReconciliationDedup,
        ...(deps.repoConfigStore
          ? { resolveInboxCatId: createRepoInboxOwnerResolver(deps.repoConfigStore, ghInboxCatId, log) }
          : {}),
        redis: deps.redis as import('./RedisDeliveryDedup.js').RedisLike,
        deliveryDeps: deps.deliveryDeps,
        // F168 Phase A P1-1b: pass community event services to webhook handler
        eventLog: ghEventLog,
        projector: ghProjector as import('./GitHubRepoWebhookHandler.js').GitHubRepoHandlerDeps['projector'],
        classifyIssueComment: deps.classifyGitHubIssueComment,
      },
    );
    webhookHandlers.set('github-repo-event', ghHandler);
    log.info('[F141] GitHub Repo Inbox webhook handler registered');
  } else if (ghWebhookSecret || ghRepoAllowlist || ghInboxCatId) {
    log.warn('[F141] GitHub Repo Inbox partially configured — set all 3 env vars + Redis to enable');
  }
}
