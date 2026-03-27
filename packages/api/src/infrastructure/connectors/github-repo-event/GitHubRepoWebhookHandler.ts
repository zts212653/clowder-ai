/**
 * F141: GitHub Repo Webhook Handler
 *
 * Pipeline: HMAC → event filter → allowlist → validate → dedup → normalize → bind thread → deliver → trigger → confirm
 */
import type { CatId, ConnectorSource } from '@cat-cafe/shared';
import type { WebhookHandleResult } from '../../../routes/connector-webhooks.js';
import type {
  ConnectorDeliveryDeps,
  ConnectorDeliveryInput,
  ConnectorDeliveryResult,
} from '../../email/deliver-connector-message.js';
import type { IConnectorThreadBindingStore } from '../ConnectorThreadBindingStore.js';
import type { ReconciliationDedup } from './ReconciliationDedup.js';
import type { RedisDeliveryDedup, RedisLike } from './RedisDeliveryDedup.js';
import type { GitHubRepoInboxConfig, RepoInboxSignal } from './types.js';
import { verifyGitHubSignature } from './verify-signature.js';

const CONNECTOR_ID = 'github-repo-event';

const ALLOWED_EVENTS: Record<string, readonly string[]> = {
  pull_request: ['opened', 'ready_for_review'],
  issues: ['opened'],
};

export interface GitHubRepoHandlerDeps {
  readonly bindingStore: Pick<IConnectorThreadBindingStore, 'getByExternal' | 'bind'>;
  readonly threadStore: {
    create(userId: string, title?: string): Promise<{ id: string }> | { id: string };
  };
  readonly deliverFn: (deps: ConnectorDeliveryDeps, input: ConnectorDeliveryInput) => Promise<ConnectorDeliveryResult>;
  readonly invokeTrigger: {
    trigger(threadId: string, catId: CatId, userId: string, message: string, messageId: string): void;
  };
  readonly dedup: RedisDeliveryDedup;
  readonly deliveryDeps?: ConnectorDeliveryDeps;
  readonly redis?: RedisLike; // KD-20: per-repo inbox thread creation lock
  readonly reconciliationDedup?: Pick<ReconciliationDedup, 'markNotified'>; // Phase B bridge
}

export class GitHubRepoWebhookHandler {
  readonly connectorId = CONNECTOR_ID;

  constructor(
    private readonly config: GitHubRepoInboxConfig,
    private readonly deps: GitHubRepoHandlerDeps,
  ) {}

  async handleWebhook(body: unknown, headers: Record<string, string>, rawBody?: Buffer): Promise<WebhookHandleResult> {
    // 1. HMAC verification (KD-11)
    if (!rawBody || !verifyGitHubSignature(this.config.webhookSecret, rawBody, headers['x-hub-signature-256'])) {
      return { kind: 'error', status: 403, message: 'Invalid signature' };
    }

    // 2. Event type filter
    const eventType = headers['x-github-event'];
    const allowedActions = ALLOWED_EVENTS[eventType];
    if (!allowedActions) {
      return { kind: 'skipped', reason: `Unhandled event type: ${eventType}` };
    }

    const payload = body as Record<string, unknown>;
    const action = payload.action as string;
    if (!allowedActions.includes(action)) {
      return { kind: 'skipped', reason: `Unhandled action: ${eventType}.${action}` };
    }

    // 3. Repo allowlist
    const repo = (payload.repository as { full_name: string })?.full_name;
    if (!this.config.repoAllowlist.includes(repo)) {
      return { kind: 'skipped', reason: `Repo not in allowlist: ${repo}` };
    }

    // 4. Validate subject exists (P2-1: fail-closed on malformed payload)
    const subject = (payload[eventType] ?? payload.issue) as Record<string, unknown> | undefined;
    if (!subject) {
      return { kind: 'error', status: 400, message: `Missing subject in ${eventType} payload` };
    }

    // 5. Skip draft PRs on opened
    if (eventType === 'pull_request' && action === 'opened' && subject.draft) {
      return { kind: 'skipped', reason: 'Skipping draft PR opened event' };
    }

    // 6. Delivery ID dedup (KD-13) — reject empty/missing delivery ID
    const deliveryId = headers['x-github-delivery'];
    if (!deliveryId) {
      return { kind: 'error', status: 400, message: 'Missing x-github-delivery header' };
    }
    if (!(await this.deps.dedup.claim(deliveryId))) {
      return { kind: 'skipped', reason: `Duplicate delivery: ${deliveryId}` };
    }

    // P1-3: Separate delivery try-catch from confirm.
    // If delivery fails → rollback (safe: message not sent, GitHub can retry).
    // If confirm fails → do NOT rollback (message delivered, claim stays to block retries).
    let delivered: ConnectorDeliveryResult;
    // 7. Normalize (hoisted for Phase B bridge access after confirm)
    const signal = this.normalize(eventType, action, payload, subject, deliveryId);
    try {
      // 8. Find or create per-repo inbox thread (KD-14, KD-20)
      const threadId = await this.ensureInboxThread(signal.repoFullName);

      // 9. Build message
      const content = this.formatMessage(signal);

      // 10. ConnectorSource (KD-12)
      const source: ConnectorSource = {
        connector: CONNECTOR_ID,
        label: 'Repo Inbox',
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
        sender: {
          id: String((payload.sender as { id: number }).id),
          name: signal.authorLogin,
        },
      };

      // 11. Deliver (AC-A7)
      delivered = await this.deps.deliverFn(this.deps.deliveryDeps ?? ({} as ConnectorDeliveryDeps), {
        threadId,
        userId: this.config.defaultUserId,
        catId: this.config.inboxCatId,
        content,
        source,
      });

      // 12. Trigger cat (KD-17)
      this.deps.invokeTrigger.trigger(
        threadId,
        this.config.inboxCatId as CatId,
        this.config.defaultUserId,
        content,
        delivered.messageId,
      );
    } catch (err) {
      // Safe rollback: message not delivered — allow GitHub retry
      await this.deps.dedup.rollback(deliveryId);
      throw err;
    }

    // 13. Confirm dedup — outside try so failure does NOT trigger rollback.
    // If confirm fails, 'pending' claim stays in Redis (blocks retries until 24h TTL — safe).
    try {
      await this.deps.dedup.confirm(deliveryId);
    } catch {
      // Best-effort: claimed key persists, preventing duplicate delivery
    }

    // 14. Mark business dedup (Phase B bridge — KD-15)
    // Best-effort: failure here doesn't affect Phase A delivery.
    try {
      await this.deps.reconciliationDedup?.markNotified(signal.repoFullName, signal.subjectType, signal.number);
    } catch {
      // Phase B reconciliation will still work — it just won't skip this item
    }

    return { kind: 'processed', messageId: delivered.messageId };
  }

  private normalize(
    eventType: string,
    action: string,
    payload: Record<string, unknown>,
    subject: Record<string, unknown>,
    deliveryId: string,
  ): RepoInboxSignal {
    const repo = (payload.repository as { full_name: string }).full_name;
    return {
      eventType: `${eventType}.${action}` as RepoInboxSignal['eventType'],
      repoFullName: repo,
      subjectType: eventType === 'pull_request' ? 'pr' : 'issue',
      number: subject.number as number,
      title: subject.title as string,
      url: subject.html_url as string,
      authorLogin: (subject.user as { login: string }).login,
      authorAssociation: (subject.author_association as string) ?? 'NONE',
      deliveryId,
      action,
    };
  }

  private formatMessage(signal: RepoInboxSignal): string {
    const typeEmoji = signal.subjectType === 'pr' ? '\u{1F500}' : '\u{1F195}';
    const actionLabel = signal.action === 'ready_for_review' ? 'ready for review' : 'opened';
    return [
      `${typeEmoji} **${signal.subjectType === 'pr' ? 'PR' : 'Issue'} #${signal.number}** ${actionLabel}`,
      `**${signal.title}**`,
      `by \`${signal.authorLogin}\` (${signal.authorAssociation}) in \`${signal.repoFullName}\``,
      signal.url,
    ].join('\n');
  }

  private async ensureInboxThread(repoFullName: string): Promise<string> {
    const existing = await this.deps.bindingStore.getByExternal(CONNECTOR_ID, repoFullName);
    if (existing) return existing.threadId;

    // KD-20: Per-repo NX lock prevents concurrent orphan thread creation
    const lockKey = `f141:inbox-lock:${repoFullName}`;
    if (this.deps.redis) {
      const locked = await this.deps.redis.set(lockKey, '1', 'EX', 30, 'NX');
      if (!locked) {
        // Another request holds the lock — poll for the binding
        for (let i = 0; i < 10; i++) {
          await new Promise((resolve) => setTimeout(resolve, 100));
          const retry = await this.deps.bindingStore.getByExternal(CONNECTOR_ID, repoFullName);
          if (retry) return retry.threadId;
        }
        throw new Error(`Timeout waiting for inbox thread creation: ${repoFullName}`);
      }

      try {
        // Double-check after acquiring lock
        const recheck = await this.deps.bindingStore.getByExternal(CONNECTOR_ID, repoFullName);
        if (recheck) return recheck.threadId;

        const thread = await this.deps.threadStore.create(
          this.config.defaultUserId,
          `Repo Inbox \u00B7 ${repoFullName}`,
        );
        await this.deps.bindingStore.bind(CONNECTOR_ID, repoFullName, thread.id, this.config.defaultUserId);
        return thread.id;
      } finally {
        await this.deps.redis.del(lockKey);
      }
    }

    // Fallback without Redis lock (shouldn't hit in prod — dedup requires Redis)
    const thread = await this.deps.threadStore.create(this.config.defaultUserId, `Repo Inbox \u00B7 ${repoFullName}`);
    const binding = await this.deps.bindingStore.bind(CONNECTOR_ID, repoFullName, thread.id, this.config.defaultUserId);
    return binding.threadId;
  }
}
