import { createHash } from 'node:crypto';
import type { CompanionReply } from '@clowder-ai/plugin-contract-beta28';
import { readCompanionDraftSubmissions } from '../../../cats/services/stores/companion-submission-state.js';
import type { IMessageStore, OwnerComposerDraft } from '../../../cats/services/stores/ports/MessageStore.js';
import { CompanionBridgeError } from '../companion-owner-client.js';
import { type CompanionHistoryOptions, CompanionHistorySource } from './companion-history-source.js';

export type CompanionDraftReply = Extract<CompanionReply, { kind: 'conversation-draft' }>;
export interface CompanionDraftOptions extends CompanionHistoryOptions {
  messages: IMessageStore;
  currentCallId(): string | undefined;
}
export const writableCompanionDraft = (draft: OwnerComposerDraft | null) =>
  !draft || (draft.text.length <= 8000 && !draft.contentBlocks?.length && !draft.replyTo);

export class CompanionDraftSource {
  readonly source: CompanionHistorySource;
  constructor(readonly options: CompanionDraftOptions) {
    this.source = new CompanionHistorySource(options);
  }
  async current(scopeRef?: string) {
    const threadId = await this.source.scope();
    const ref = createHash('sha256')
      .update(JSON.stringify([this.options.ownerUserId, threadId]))
      .digest('hex');
    if (scopeRef !== undefined && scopeRef !== ref) throw new CompanionBridgeError('invalid_request');
    const draft = await this.options.messages.getOwnerComposerDraft(this.options.ownerUserId, threadId);
    await this.source.scope(threadId);
    if (
      draft &&
      (draft.ownerUserId !== this.options.ownerUserId || draft.threadId !== threadId || draft.text.length > 100_000)
    )
      throw new CompanionBridgeError('unavailable');
    return {
      threadId,
      scopeRef: ref,
      draft,
      revision: draft?.revision ?? 0,
      submissions: readCompanionDraftSubmissions(draft?.companionSubmissions ?? []),
    };
  }
  async save(scopeRef: string, expectedRevision: number, text: string): Promise<CompanionDraftReply> {
    if (!Number.isInteger(expectedRevision) || expectedRevision < 0 || text.length > 8000)
      throw new CompanionBridgeError('invalid_request');
    const current = await this.current(scopeRef);
    if (!writableCompanionDraft(current.draft))
      return { kind: 'conversation-draft', v: 1, status: 'readonly', revision: current.revision };
    await this.source.scope(current.threadId);
    const result = await this.options.messages.putOwnerComposerDraft(this.options.ownerUserId, current.threadId, {
      expectedRevision,
      text,
      updatedAt: Date.now(),
    });
    await this.source.scope(current.threadId);
    const latest = await this.current(scopeRef);
    if (result.kind === 'updated') return this.view(latest, []);
    return {
      kind: 'conversation-draft',
      v: 1,
      status: writableCompanionDraft(latest.draft) ? 'conflict' : 'readonly',
      revision: latest.revision,
    };
  }
  view(
    current: Awaited<ReturnType<CompanionDraftSource['current']>>,
    submissions: Extract<CompanionDraftReply, { status: 'available' }>['submissions'],
  ): CompanionDraftReply {
    return {
      kind: 'conversation-draft',
      v: 1,
      status: 'available',
      scopeRef: current.scopeRef,
      revision: current.revision,
      text: current.draft?.text ?? '',
      writable: writableCompanionDraft(current.draft),
      submissions,
    };
  }
}
