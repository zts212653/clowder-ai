import type { CompanionReply } from '@clowder-ai/plugin-contract-beta28';
import { z } from 'zod';
import type { CompanionDraftSubmission } from '../../../cats/services/stores/companion-submission-state.js';
import {
  companionDeliveryMatches,
  companionSubmissionKey,
  companionTextDigest,
} from '../../../cats/services/stores/companion-submission-state.js';
import { CompanionBridgeError } from '../companion-owner-client.js';
import { type CompanionDraftOptions, CompanionDraftSource, writableCompanionDraft } from './companion-draft-source.js';
import { sendCompanionText } from './companion-modern-live.js';

type Delivery = Extract<CompanionReply, { kind: 'delivery'; v: 2 }>;
type ReadDelivery = Exclude<Delivery, { delivery: 'rejected' }>;
type SubmissionInput = { scopeRef: string; text: string; clientMessageId: string; submissionRevision: number };
type CurrentDraft = Awaited<ReturnType<CompanionDraftSource['current']>>;
export class CompanionSubmissionDelivery {
  readonly drafts: CompanionDraftSource;
  constructor(private readonly options: CompanionDraftOptions) {
    this.drafts = new CompanionDraftSource(options);
  }
  private unconfirmed(clientMessageId: string, callId: string | null): ReadDelivery {
    return { kind: 'delivery', v: 2, delivery: 'unconfirmed', clientMessageId, callId, messageId: null };
  }
  private rejected(
    clientMessageId: string,
    reason: 'draft_changed' | 'unsupported_draft' | 'pending_limit',
    revision: number,
  ): Delivery {
    return { kind: 'delivery', v: 2, delivery: 'rejected', clientMessageId, reason, draftRevision: revision };
  }
  async receipt(threadId: string, submission: CompanionDraftSubmission): Promise<ReadDelivery> {
    await this.drafts.source.scope(threadId);
    const original = await this.options.messages.getByIdempotencyKey(
      this.options.ownerUserId,
      threadId,
      companionSubmissionKey(submission),
    );
    await this.drafts.source.scope(threadId);
    const fact = original?.companionDeliveryReceipt;
    return original &&
      original.userId === this.options.ownerUserId &&
      original.threadId === threadId &&
      original.content === submission.text &&
      fact &&
      fact.clientMessageId === submission.clientMessageId &&
      fact.callId === submission.callId &&
      companionDeliveryMatches(original, fact)
      ? {
          kind: 'delivery',
          v: 2,
          delivery: 'accepted',
          clientMessageId: fact.clientMessageId,
          messageId: original.id,
          callId: fact.callId,
        }
      : this.unconfirmed(submission.clientMessageId, submission.callId);
  }
  async readDraft() {
    const current = await this.drafts.current();
    const submissions = [];
    for (const submission of current.submissions)
      submissions.push({
        clientMessageId: submission.clientMessageId,
        text: submission.text,
        submissionRevision: submission.submissionRevision,
        receipt: await this.receipt(current.threadId, submission),
      });
    await this.drafts.source.scope(current.threadId);
    const latestAccepted = submissions.reduce(
      (latest, row, index) => (row.receipt.delivery === 'accepted' ? index : latest),
      -1,
    );
    // The public recovery slot is bounded; older acceptance facts remain on their original Messages.
    return this.drafts.view(
      current,
      submissions.filter((row, index) => row.receipt.delivery !== 'accepted' || index === latestAccepted),
    );
  }
  async saveDraft(scopeRef: string, expectedRevision: number, text: string) {
    const result = await this.drafts.save(scopeRef, expectedRevision, text);
    return result.status === 'available' ? this.readDraft() : result;
  }
  async readDelivery(scopeRef: string, clientMessageId: string): Promise<ReadDelivery> {
    const current = await this.drafts.current(scopeRef);
    const submission = current.submissions.find((item) => item.clientMessageId === clientMessageId);
    return submission ? this.receipt(current.threadId, submission) : this.unconfirmed(clientMessageId, null);
  }
  private async reserve(input: SubmissionInput, current: CurrentDraft): Promise<CompanionDraftSubmission | Delivery> {
    const previous = current.submissions.find((item) => item.clientMessageId === input.clientMessageId);
    if (previous) {
      if (previous.text !== input.text.trim() || previous.submissionRevision !== input.submissionRevision)
        throw new CompanionBridgeError('invalid_request');
      return previous;
    }
    if (!writableCompanionDraft(current.draft))
      return this.rejected(input.clientMessageId, 'unsupported_draft', current.revision);
    if (current.revision !== input.submissionRevision || current.draft?.text.trim() !== input.text.trim())
      return this.rejected(input.clientMessageId, 'draft_changed', current.revision);
    const unresolved: CompanionDraftSubmission[] = [];
    for (const prior of current.submissions) {
      if ((await this.receipt(current.threadId, prior)).delivery !== 'accepted') unresolved.push(prior);
    }
    if (unresolved.length >= 32) return this.rejected(input.clientMessageId, 'pending_limit', current.revision);
    const submission: CompanionDraftSubmission = {
      clientMessageId: input.clientMessageId,
      text: input.text.trim(),
      callId: this.options.currentCallId() ?? null,
      submissionRevision: input.submissionRevision,
      reservationRevision: current.revision + 1,
      createdAt: Date.now(),
    };
    await this.drafts.source.scope(current.threadId);
    const reserved = await this.options.messages.putOwnerComposerDraft(this.options.ownerUserId, current.threadId, {
      expectedRevision: current.revision,
      text: current.draft?.text ?? '',
      updatedAt: Date.now(),
      companionSubmissions: [...unresolved, submission],
    });
    await this.drafts.source.scope(current.threadId);
    if (reserved.kind === 'updated') return submission;
    const raced = await this.drafts.current(input.scopeRef);
    const winner = raced.submissions.find((item) => item.clientMessageId === input.clientMessageId);
    if (!winner || winner.text !== submission.text || winner.submissionRevision !== input.submissionRevision)
      return this.rejected(input.clientMessageId, 'draft_changed', raced.revision);
    return winner;
  }

  async submit(input: SubmissionInput): Promise<Delivery> {
    if (
      !z.string().uuid().safeParse(input.clientMessageId).success ||
      !input.text.trim() ||
      input.text.length > 8000 ||
      !Number.isInteger(input.submissionRevision) ||
      input.submissionRevision < 0
    )
      throw new CompanionBridgeError('invalid_request');
    const current = await this.drafts.current(input.scopeRef);
    const submission = await this.reserve(input, current);
    if ('kind' in submission) return submission;
    const known = await this.receipt(current.threadId, submission);
    if (known.delivery === 'accepted') return known;
    if (submission.callId !== null && this.options.currentCallId() !== submission.callId)
      return this.unconfirmed(submission.clientMessageId, submission.callId);
    const original = await this.options.messages.getByIdempotencyKey(
      this.options.ownerUserId,
      current.threadId,
      companionSubmissionKey(submission),
    );
    if (
      original &&
      (original.content !== submission.text || original.recall || original.deletedAt || original._tombstone)
    )
      return this.unconfirmed(submission.clientMessageId, submission.callId);
    await this.drafts.source.scope(current.threadId);
    const result = await sendCompanionText({
      client: this.options.client,
      text: submission.text,
      clientMessageId: submission.clientMessageId,
      ...(submission.callId !== null ? { callId: submission.callId } : {}),
      modern: true,
      composerDraftRevision: submission.reservationRevision,
      conversationThread: async () => current.threadId,
    });
    if (result.kind !== 'delivery' || result.delivery !== 'accepted' || !('messageId' in result)) return known;
    await this.drafts.source.scope(current.threadId);
    const recorded = await this.options.messages.recordCompanionDeliveryAcceptance(result.messageId, {
      ownerUserId: this.options.ownerUserId,
      threadId: current.threadId,
      clientMessageId: submission.clientMessageId,
      callId: submission.callId,
      contentDigest: companionTextDigest(submission.text),
      acceptedAt: Date.now(),
    });
    await this.drafts.source.scope(current.threadId);
    if (!recorded) return this.unconfirmed(submission.clientMessageId, submission.callId);
    // Acceptance is authoritative even when clearing the draft fails or a newer draft wins its CAS.
    await Promise.resolve()
      .then(() =>
        this.options.messages.clearOwnerComposerDraft(
          this.options.ownerUserId,
          current.threadId,
          submission.reservationRevision,
          Date.now(),
        ),
      )
      .catch(() => undefined);
    await this.drafts.source.scope(current.threadId);
    return this.receipt(current.threadId, submission);
  }
}
