/**
 * F141: GitHub Repo Webhook Handler
 *
 * Pipeline: HMAC → event filter → allowlist → validate → dedup → normalize → bind thread → deliver → trigger → confirm
 */
import type { CatId, CommunityEvent, CommunityEventKind, ConnectorSource } from '@cat-cafe/shared';
import type { ICommunityEventLog } from '../../../domains/community/CommunityEventLog.js';
import { issueCommentEventId } from '../../../domains/community/community-keys.js';
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

/** Minimal projector interface — only apply() needed here. */
interface ICommunityProjectorApply {
  apply(event: CommunityEvent): Promise<void>;
}

const CONNECTOR_ID = 'github-repo-event';
/** Repo owner's own PRs/issues should not trigger community intake. */
const SKIP_AUTHOR_ASSOCIATIONS = new Set(['OWNER']);

const ALLOWED_EVENTS: Record<string, readonly string[]> = {
  pull_request: ['opened', 'ready_for_review', 'closed'],
  // F168 Phase A: lifecycle; Phase B: labeled/unlabeled activity signals
  issues: ['opened', 'closed', 'reopened', 'labeled', 'unlabeled'],
  // F168 Phase B: activity signal events (log-only, no inbox notification)
  issue_comment: ['created'],
  pull_request_review: ['submitted'],
};

/**
 * Events that are appended to the community event log but do NOT generate
 * a Repo Inbox notification. These are activity signals for the projector
 * state machine; delivery decisions are made downstream by the delivery policy.
 */
const LOG_ONLY_EVENTS = new Set([
  'issue_comment.created',
  'issues.labeled',
  'issues.unlabeled',
  'pull_request_review.submitted',
]);

export interface GitHubRepoHandlerDeps {
  readonly bindingStore: Pick<IConnectorThreadBindingStore, 'getByExternal' | 'bind'>;
  readonly threadStore: {
    create(userId: string, title?: string): Promise<{ id: string }> | { id: string };
  };
  readonly deliverFn: (deps: ConnectorDeliveryDeps, input: ConnectorDeliveryInput) => Promise<ConnectorDeliveryResult>;
  readonly invokeTrigger: {
    trigger(
      threadId: string,
      catId: CatId,
      userId: string,
      message: string,
      messageId: string,
    ): void | Promise<unknown>;
  };
  readonly dedup: RedisDeliveryDedup;
  readonly deliveryDeps?: ConnectorDeliveryDeps;
  readonly redis?: RedisLike; // KD-20: per-repo inbox thread creation lock
  readonly reconciliationDedup?: Pick<ReconciliationDedup, 'markNotified'>; // Phase B bridge
  // F168 Phase A: community event log + projector (best-effort, optional)
  readonly eventLog?: ICommunityEventLog;
  readonly projector?: ICommunityProjectorApply;
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

    // 4. Delivery ID dedup (KD-13) — reject empty/missing delivery ID
    const deliveryId = headers['x-github-delivery'];
    if (!deliveryId) {
      return { kind: 'error', status: 400, message: 'Missing x-github-delivery header' };
    }
    if (!(await this.deps.dedup.claim(deliveryId))) {
      return { kind: 'skipped', reason: `Duplicate delivery: ${deliveryId}` };
    }

    // 4.5. Log-only fast path: activity signals go to event log but NOT to Repo Inbox.
    // These events (comments, labels, reviews) are noise for the inbox but valuable for
    // the projector state machine and delivery policy downstream.
    // Must run BEFORE subject validation since these event types have different payload shapes.
    // P1-3: If append fails, rollback dedup so GitHub can retry — event log is the sole product.
    const eventKey = `${eventType}.${action}`;
    if (LOG_ONLY_EVENTS.has(eventKey)) {
      try {
        await this.emitCommunityEventLogOnly(eventType, action, payload, deliveryId);
        try {
          await this.deps.dedup.confirm(deliveryId);
        } catch {
          // Best-effort confirm; pending claim still prevents retries
        }
      } catch (err) {
        // Append failed — rollback so GitHub retries delivery
        await this.deps.dedup.rollback(deliveryId);
        throw err;
      }
      return { kind: 'processed', messageId: '' };
    }

    // 5. Validate subject exists (P2-1: fail-closed on malformed payload)
    // Only reached for inbox-notification events (not log-only).
    const subject = (payload[eventType] ?? payload.issue) as Record<string, unknown> | undefined;
    if (!subject) {
      return { kind: 'error', status: 400, message: `Missing subject in ${eventType} payload` };
    }

    // 5.5. Skip draft PRs on opened
    if (eventType === 'pull_request' && action === 'opened' && subject.draft) {
      return { kind: 'skipped', reason: 'Skipping draft PR opened event' };
    }

    // 5.6. Skip repo owner's own PRs/issues — not community contributions
    // (Applied after log-only check: owner activity signals are still logged above)
    const authorAssociation = (subject.author_association as string) ?? '';
    if (SKIP_AUTHOR_ASSOCIATIONS.has(authorAssociation)) {
      return { kind: 'skipped', reason: `Skipping ${authorAssociation} event` };
    }

    // P1-3: Separate delivery try-catch from confirm.
    // If delivery fails → rollback (safe: message not sent, GitHub can retry).
    // If confirm fails → do NOT rollback (message delivered, claim stays to block retries).
    let delivered: ConnectorDeliveryResult;
    // 7. Normalize (hoisted for Phase B bridge access after confirm)
    const signal = this.normalize(eventType, action, payload, subject, deliveryId);

    // Cloud P2: For merged PRs (pull_request.closed with merged=true), rewrite signal.action
    // so formatMessage shows "merged" rather than "closed" in the Repo Inbox notification.
    // The original webhook action is always "closed"; GitHub uses merged=true to distinguish.
    // Must happen before formatMessage; the kindMap rawKey check is updated below to match.
    if (eventType === 'pull_request' && action === 'closed') {
      const prData = payload.pull_request as { merged?: boolean } | undefined;
      if (prData?.merged) {
        (signal as unknown as { action: string }).action = 'merged';
      }
    }

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
      void Promise.resolve(
        this.deps.invokeTrigger.trigger(
          threadId,
          this.config.inboxCatId as CatId,
          this.config.defaultUserId,
          content,
          delivered.messageId,
        ),
      ).catch(() => {});
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

    // 15. Emit community event (F168 Phase A/B — best-effort, never blocks notification path)
    if (this.deps.eventLog) {
      try {
        const kindMap: Record<string, CommunityEventKind> = {
          'pull_request.opened': 'pr.opened',
          'pull_request.ready_for_review': 'pr.ready_for_review',
          'issues.opened': 'issue.opened',
          'issues.closed': 'issue.closed',
          'issues.reopened': 'issue.reopened',
          // pull_request.closed/merged is handled below (merged=true → pr.merged, false → pr.closed)
          // Note: signal.action may be 'merged' here (Cloud P2 rewrite), so rawKey can be 'pull_request.merged'
        };
        const rawKey = `${signal.subjectType === 'pr' ? 'pull_request' : 'issues'}.${signal.action}`;

        // Special case: pull_request.closed or pull_request.merged (Cloud P2: signal.action rewritten for inbox)
        // Use original webhook `action` (not signal.action) to detect this path reliably.
        let eventKind: CommunityEventKind | undefined = kindMap[rawKey];
        if (eventType === 'pull_request' && action === 'closed') {
          const prPayload = payload.pull_request as { merged?: boolean } | undefined;
          eventKind = prPayload?.merged ? 'pr.merged' : 'pr.closed';
        }

        if (eventKind) {
          const subjectKey = `${signal.subjectType}:${signal.repoFullName}#${signal.number}`;
          // P1-1: pr.merged / pr.closed must use lifecycle sourceEventId to dedup with polling paths
          // (CiCdRouter + ReviewFeedbackTaskSpec both emit lifecycle:${subjectKey}:merged|closed).
          // All other inbox-notification events remain delivery-ID keyed.
          const sourceEventId =
            eventKind === 'pr.merged' || eventKind === 'pr.closed'
              ? `lifecycle:${subjectKey}:${eventKind === 'pr.merged' ? 'merged' : 'closed'}`
              : deliveryId;
          // P1-2: pr.opened must include PR body so projector can parse linkedIssues
          // Cloud R2 P2a: also include body on pr.merged/pr.closed so projector can pick up
          //   closing keywords added to the PR description after it was originally opened
          const eventPayload: Record<string, unknown> = { title: signal.title, authorLogin: signal.authorLogin };
          if (eventKind === 'pr.opened' || eventKind === 'pr.merged' || eventKind === 'pr.closed') {
            eventPayload.body = (subject as Record<string, unknown>).body ?? null;
            // Cloud R4 P1-2: gate linked-issue parsing to default-branch PRs.
            // GitHub only auto-closes issues from PRs targeting the default branch.
            // Carry isDefaultBranchPr so the projector can skip closing-keyword parsing
            // for release-branch PRs that would otherwise wrongly mark issues fixed.
            const base = (subject as Record<string, unknown>).base as Record<string, unknown> | undefined;
            const baseBranch = typeof base?.ref === 'string' ? base.ref : undefined;
            const repoData = payload.repository as Record<string, unknown> | undefined;
            const defaultBranch = typeof repoData?.default_branch === 'string' ? repoData.default_branch : undefined;
            if (baseBranch !== undefined && defaultBranch !== undefined) {
              eventPayload.isDefaultBranchPr = baseBranch === defaultBranch;
            }
            // If baseBranch or defaultBranch unknown → omit isDefaultBranchPr
            // (projector treats undefined as backward-compat default: parse as normal)
          }
          const communityEvent: CommunityEvent = {
            sourceEventId,
            subjectKey,
            kind: eventKind,
            classification: 'state-changing',
            payload: eventPayload,
            at: Date.now(),
          };
          const { appended } = await this.deps.eventLog.append(communityEvent);
          if (appended && this.deps.projector) {
            await this.deps.projector.apply(communityEvent);
          } else if (
            !appended &&
            this.deps.projector &&
            (eventKind === 'pr.merged' || eventKind === 'pr.closed') &&
            eventPayload.body != null
          ) {
            // Cloud R4 P1-1: poller won the race and already appended lifecycle:...:merged
            // without body. Emit a body-enrichment event with a distinct sourceEventId so the
            // projector can parse late-added closing keywords (e.g. "Fixes #N" edited into PR
            // description after opening) and cascade linked issues to fixed.
            const bodyEnrichmentEvent: CommunityEvent = {
              ...communityEvent,
              sourceEventId: `${communityEvent.sourceEventId}:body-enrichment`,
            };
            const { appended: enrichmentAppended } = await this.deps.eventLog.append(bodyEnrichmentEvent);
            if (enrichmentAppended) {
              await this.deps.projector.apply(bodyEnrichmentEvent);
            }
          }
        }
      } catch {
        // Best-effort — community event failure never blocks notification delivery
      }
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
    const ACTION_LABELS: Record<string, string> = {
      opened: 'opened',
      ready_for_review: 'ready for review',
      closed: 'closed',
      reopened: 'reopened',
      merged: 'merged',
    };
    const actionLabel = ACTION_LABELS[signal.action] ?? signal.action;
    return [
      `${typeEmoji} **${signal.subjectType === 'pr' ? 'PR' : 'Issue'} #${signal.number}** ${actionLabel}`,
      `**${signal.title}**`,
      `by \`${signal.authorLogin}\` (${signal.authorAssociation}) in \`${signal.repoFullName}\``,
      signal.url,
    ].join('\n');
  }

  /**
   * Emit a community event for log-only webhook events (activity signals).
   * These events bypass the Repo Inbox notification path entirely.
   *
   * P1-3: Errors are NOT swallowed here. The caller (log-only fast path) is
   * responsible for rollback + re-throw so GitHub can retry on append failure.
   * Event log is the sole product for these events; silent failure = data loss.
   */
  private async emitCommunityEventLogOnly(
    eventType: string,
    action: string,
    payload: Record<string, unknown>,
    deliveryId: string,
  ): Promise<void> {
    if (!this.deps.eventLog) return;

    const repo = (payload.repository as { full_name: string }).full_name;

    let kind: CommunityEventKind | undefined;
    let subjectKey: string | undefined;
    let sourceEventId: string = deliveryId;
    let eventPayload: Record<string, unknown> = {};

    if (eventType === 'issue_comment' && action === 'created') {
      const issue = payload.issue as { number: number; pull_request?: unknown } | undefined;
      // P1-4a: include author_association for delivery policy (OWNER/MEMBER → silent-log)
      const comment = payload.comment as
        | {
            id: number;
            user?: { login?: string };
            author_association?: string;
          }
        | undefined;
      if (!issue || !comment) return;
      // Cloud P1: GitHub sends PR conversation comments as issue_comment with issue.pull_request
      // set to a non-null object. These are PR activity, not issue activity — skip to avoid
      // polluting the issue projector with PR discussion noise.
      if (issue.pull_request != null) return;
      kind = 'issue.commented';
      subjectKey = `issue:${repo}#${issue.number}`;
      // Unified sourceEventId: same key used by the polling path (IssueCommentTaskSpec)
      // for idempotent convergence — delivery ID would differ between the two paths.
      // P2-③: use shared factory so webhook + polling paths can never drift on format.
      sourceEventId = issueCommentEventId(repo, issue.number, comment.id);
      eventPayload = {
        commentId: comment.id,
        authorLogin: comment.user?.login ?? '',
        // P1-4a: required by delivery policy to distinguish maintainer vs external activity
        authorAssociation: comment.author_association ?? 'NONE',
      };
    } else if (eventType === 'issues' && (action === 'labeled' || action === 'unlabeled')) {
      const issue = payload.issue as { number: number; title?: string } | undefined;
      const label = payload.label as { name?: string } | undefined;
      if (!issue) return;
      kind = 'issue.labeled';
      subjectKey = `issue:${repo}#${issue.number}`;
      eventPayload = { labelName: label?.name ?? '', action, title: issue.title ?? '' };
    } else if (eventType === 'pull_request_review' && action === 'submitted') {
      const pr = payload.pull_request as { number: number; title?: string } | undefined;
      // P1-4a/4b: include author_association; use stable review key not delivery ID
      const review = payload.review as
        | {
            id?: number;
            user?: { login?: string };
            author_association?: string;
          }
        | undefined;
      if (!pr) return;
      kind = 'pr.review_submitted';
      subjectKey = `pr:${repo}#${pr.number}`;
      // P1-4b: stable sourceEventId for dedup with future polling path
      sourceEventId = `review:${repo}#${pr.number}:${review?.id ?? deliveryId}`;
      eventPayload = {
        reviewId: review?.id,
        reviewerLogin: review?.user?.login ?? '',
        title: pr.title ?? '',
        // P1-4a: required by delivery policy (OWNER/MEMBER review → silent-log in awaiting_external)
        authorAssociation: review?.author_association ?? 'NONE',
      };
    }

    if (!kind || !subjectKey) return;

    const communityEvent: CommunityEvent = {
      sourceEventId,
      subjectKey,
      kind,
      classification: 'informational',
      payload: eventPayload,
      at: Date.now(),
    };
    // P1-3: Let errors propagate — caller rolls back dedup on failure.
    const { appended } = await this.deps.eventLog.append(communityEvent);
    if (appended && this.deps.projector) {
      await this.deps.projector.apply(communityEvent);
    } else if (!appended && this.deps.projector) {
      // Cloud R5 P1: repair path — event is already in log (prior attempt's append() succeeded
      // but projector.apply() threw, causing dedup rollback + GitHub retry). Informational
      // events are idempotent; apply best-effort to repair lastExternalActivityAt without
      // triggering another rollback → retry → loop.
      try {
        await this.deps.projector.apply(communityEvent);
      } catch {
        // Best-effort: event log is source of truth; projector is eventual consistency.
      }
    }
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
