import {
  type ContentModificationRequest,
  type ContentModificationRequestView,
  contentModificationRequestSchema,
} from '@cat-cafe/shared';
import type { IMessageStore } from '../../cats/services/stores/ports/MessageStore.js';
import type { ITaskStore } from '../../cats/services/stores/ports/TaskStore.js';
import type { ITurnExecutionStore } from '../../cats/services/stores/ports/TurnExecutionStore.js';
import type { EntrustedWorkLifecycleService } from '../../growing/EntrustedWorkLifecycleService.js';
import type { MediaReviewPrincipal } from '../../video-studio/content-owner/published-media-access.js';
import type { ArtifactReviewStore } from '../artifact-review/store.js';
import { ContentModificationCancellationService } from './control/cancellation-service.js';
import { readModificationControl } from './control/control-read.js';
import { readModificationExecution } from './execution-view.js';
import {
  ContentModificationJournalError,
  type ContentModificationProgress,
  type ContentModificationRecord,
  modificationRequestId,
} from './journal.js';
import { type ModificationLabels, persistModificationSource } from './request-source.js';
import { admitModificationTask, ModificationAdmissionError } from './task-admission.js';

export interface ModificationContentPort {
  /** Permission and exact source validation; resume may recover an already retained owner snapshot. */
  inspect(
    payload: ContentModificationRequest,
    principal: MediaReviewPrincipal,
    resuming: boolean,
  ): Promise<Pick<ModificationLabels, 'title' | 'completionRule'>>;
  prepare(
    record: ContentModificationRecord,
    principal: MediaReviewPrincipal,
  ): Promise<NonNullable<ContentModificationProgress['prepared']>>;
  validatePrepared(record: ContentModificationRecord, principal: MediaReviewPrincipal): Promise<void>;
  prepareCommit(
    record: ContentModificationRecord,
    principal: MediaReviewPrincipal,
  ): Promise<() => NonNullable<ContentModificationProgress['review']>>;
}

export type ModificationRequestView = ContentModificationRequestView;

export class ContentModificationService {
  private readonly cancellations: ContentModificationCancellationService;
  constructor(
    private readonly deps: {
      store: ArtifactReviewStore;
      messages: IMessageStore;
      turnExecutions?: Pick<ITurnExecutionStore, 'get'>;
      tasks: ITaskStore;
      lifecycle: EntrustedWorkLifecycleService;
      content: ModificationContentPort;
      authorizeTarget: (
        payload: ContentModificationRequest,
        ownerUserId: string,
      ) => Promise<Pick<ModificationLabels, 'targetName' | 'threadTitle'>>;
      dispatch: () => Promise<void>;
      onError: (error: unknown) => void;
      sourceChanged?: (ownerUserId: string, threadId: string, messageId: string) => void;
      leaseDurationMs?: number;
      attemptBudgetMs?: number;
    },
  ) {
    this.cancellations = new ContentModificationCancellationService(deps);
  }

  async cancel(requestId: string, principal: MediaReviewPrincipal): Promise<ModificationRequestView> {
    this.assertHuman(principal);
    return this.project(await this.cancellations.cancel(requestId, principal.userId));
  }

  /** A current Task owner can read the content-free cancellation even after source recall or before round binding. */
  async cancelledForCat(requestId: string, principal: MediaReviewPrincipal) {
    const record = this.deps.store.requests.get(requestId, principal.userId);
    if (!record?.control) return null;
    return this.controlForCat(requestId, principal);
  }

  controlForCat(requestId: string, principal: MediaReviewPrincipal, expectedReviewId?: string) {
    return readModificationControl(this.deps, requestId, principal, expectedReviewId);
  }

  async submit(raw: unknown, principal: MediaReviewPrincipal): Promise<ModificationRequestView> {
    this.assertHuman(principal);
    const payload = contentModificationRequestSchema.parse(raw);
    const existing = this.deps.store.requests.get(
      modificationRequestId(principal.userId, payload.operationId),
      principal.userId,
    );
    const record = existing
      ? this.deps.store.requests.reserve(principal.userId, payload)
      : await this.reserve(payload, principal);
    return this.resume(record, principal);
  }

  async read(requestId: string, principal: MediaReviewPrincipal): Promise<ModificationRequestView> {
    this.assertHuman(principal);
    const record = this.deps.store.requests.get(requestId, principal.userId);
    if (!record) throw new ContentModificationJournalError('not_found');
    await this.deps.content.inspect(record.payload, principal, true);
    return this.project(record);
  }

  /** Recovery consumes the durable confirmed actor and source; it creates no new user decision. */
  async recover(): Promise<void> {
    await this.cancellations.recover();
    for (const record of this.deps.store.requests.pending()) {
      try {
        await this.resume(record, {
          userId: record.ownerUserId,
          actor: { kind: 'human', actorId: record.ownerUserId },
        });
      } catch (error) {
        this.deps.onError(error);
      }
    }
  }

  private async reserve(payload: ContentModificationRequest, principal: MediaReviewPrincipal) {
    await this.deps.authorizeTarget(payload, principal.userId);
    await this.deps.content.inspect(payload, principal, false);
    return this.deps.store.requests.reserve(principal.userId, payload);
  }

  private async resume(
    initial: ContentModificationRecord,
    principal: MediaReviewPrincipal,
  ): Promise<ModificationRequestView> {
    const journal = this.deps.store.requests;
    const durationMs = this.deps.leaseDurationMs ?? 30000;
    const lease = journal.acquire(initial.requestId, principal.userId, Date.now(), durationMs);
    if (!lease) return this.project(journal.get(initial.requestId, principal.userId) ?? initial);
    const heartbeat = setInterval(
      () => {
        try {
          journal.renew(initial.requestId, lease.token, Date.now(), durationMs);
        } catch (error) {
          clearInterval(heartbeat);
          this.deps.onError(error);
        }
      },
      Math.floor(durationMs / 3),
    );
    heartbeat.unref();
    let record = lease.record;
    try {
      await boundedModificationAttempt(async () => {
        const target = await this.deps.authorizeTarget(record.payload, record.ownerUserId);
        const content = await this.deps.content.inspect(record.payload, principal, true);
        const labels = { ...target, ...content };
        const source = await persistModificationSource(this.deps.messages, record, labels);
        const newlyLinked = !record.progress.sourceMessageId;
        if (!record.progress.sourceMessageId)
          record = journal.advance(record.requestId, lease.token, { sourceMessageId: source.id });
        if (record.progress.sourceMessageId !== source.id)
          throw new ContentModificationJournalError('operation_reused');
        if (newlyLinked) {
          try {
            this.deps.sourceChanged?.(record.ownerUserId, source.threadId, source.id);
          } catch (error) {
            this.deps.onError(error);
          }
        }
        if (!record.progress.prepared)
          record = journal.advance(record.requestId, lease.token, {
            prepared: await this.deps.content.prepare(record, principal),
          });
        await this.deps.content.validatePrepared(record, principal);
        journal.renew(record.requestId, lease.token, Date.now(), durationMs);
        if (!record.progress.task)
          record = journal.advance(record.requestId, lease.token, {
            task: await admitModificationTask(this.deps, record, labels),
          });
        if (!record.progress.review) {
          const commit = await this.deps.content.prepareCommit(record, principal);
          record = journal.bindReview(record.requestId, lease.token, commit);
        }
        // Check the same explicit target again at actual delivery; the queue also runs its own runtime preflight.
        await this.deps.authorizeTarget(record.payload, record.ownerUserId);
        journal.renew(record.requestId, lease.token, Date.now(), durationMs);
        await this.deps.dispatch();
      }, this.deps.attemptBudgetMs ?? 110000);
    } catch (error) {
      this.recordIssue(record, lease.token, error);
    } finally {
      clearInterval(heartbeat);
      journal.release(record.requestId, lease.token);
    }
    return this.project(journal.get(record.requestId, record.ownerUserId) ?? record);
  }

  private async project(record: ContentModificationRecord): Promise<ModificationRequestView> {
    const progress = record.progress;
    if (record.control) {
      const execution = await readModificationExecution(this.deps, record);
      return { record, stage: 'cancelled', ...(execution ? { execution } : {}) };
    }
    if (!progress.sourceMessageId) return { record, stage: 'saving_source' };
    if (!progress.prepared) return { record, stage: 'preparing_content' };
    if (!progress.task) return { record, stage: 'admitting_task' };
    if (!progress.review) return { record, stage: 'binding_request' };
    const intent = this.deps.store.returns.get(progress.review.receiptRef);
    const execution = await readModificationExecution(this.deps, record);
    return {
      record,
      ...(execution ? { execution } : {}),
      stage: !intent || intent.state === 'pending' ? 'pending_delivery' : intent.state,
      ...(intent
        ? { delivery: { receiptRef: intent.receiptRef, ...(intent.messageId ? { messageId: intent.messageId } : {}) } }
        : {}),
    };
  }

  private assertHuman(principal: MediaReviewPrincipal): void {
    if (principal.actor.kind !== 'human' || principal.actor.actorId !== principal.userId)
      throw new ContentModificationJournalError('not_found');
  }

  private recordIssue(record: ContentModificationRecord, token: string, error: unknown): void {
    const code =
      typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
        ? error.code
        : 'recovery_pending';
    if (
      ['lease_changed', 'task_changed'].includes(code) &&
      this.deps.store.requests.get(record.requestId, record.ownerUserId)?.control
    )
      return;
    this.deps.onError(error);
    const retryable = [
      'recovery_pending',
      'attempt_timed_out',
      'media_unavailable',
      'lease_changed',
      'version_pending',
      'task_cancellation_pending',
    ].includes(code);
    try {
      this.deps.store.requests.noteIssue(record.requestId, token, {
        code,
        retryable,
        ...(error instanceof ModificationAdmissionError ? { detail: error.message.slice(0, 4000) } : {}),
      });
    } catch (leaseError) {
      if (!(leaseError instanceof ContentModificationJournalError) || leaseError.code !== 'lease_changed')
        throw leaseError;
    }
  }
}

/** A live but stuck owner call cannot renew forever. Late completions still meet the journal token fence. */
async function boundedModificationAttempt(run: () => Promise<void>, budgetMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(Object.assign(new Error('Modification attempt timed out'), { code: 'attempt_timed_out' })),
      budgetMs,
    );
  });
  try {
    await Promise.race([run(), timeout]);
  } finally {
    clearTimeout(timer);
  }
}
