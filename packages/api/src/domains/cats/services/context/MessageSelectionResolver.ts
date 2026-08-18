import {
  MESSAGE_BUNDLE_CLI_QUOTE_DIGEST_DOMAIN,
  MESSAGE_BUNDLE_CLI_QUOTE_PROJECTION_VERSION,
  MESSAGE_BUNDLE_QUOTE_DIGEST_DOMAIN,
  MESSAGE_BUNDLE_QUOTE_PROJECTION_VERSION,
  MESSAGE_BUNDLE_RICH_BLOCK_DIGEST_DOMAIN,
  MESSAGE_BUNDLE_RICH_BLOCK_PROJECTION_VERSION,
  MESSAGE_BUNDLE_VERSION,
  MessageBundleCarrierV1Schema,
  type MessageBundleItemV1,
  type MessageBundleSelectionCliQuoteItem,
  type MessageBundleSelectionItem,
  type MessageBundleSelectionQuoteItem,
  type MessageBundleSelectionRichBlockItem,
  MessageBundleSelectionSchema,
} from '@cat-cafe/shared';
import type { IMessageStore } from '../stores/ports/MessageStore.js';
import type { IThreadStore } from '../stores/ports/ThreadStore.js';
import { getTimelineOrderTime } from '../stores/visibility.js';
import { resolveMessageBundleCarrier } from './MessageBundleCarrierResolver.js';
import { createCanonicalSourceRecordResolver, type SourceRecordResolver } from './MessageBundleSourceGroup.js';
import {
  canAccessSourceThread,
  digestMessageBundleCliQuoteProjection,
  digestMessageBundleQuoteProjection,
  digestMessageBundleRichBlockProjection,
  isSelectableMessage,
  projectCliSegment,
  projectMessageBundleQuoteSourceV1,
  projectMessageBundleReadableContent,
  quoteOffsets,
  readRichBlockFallback,
  richBlockFromRecords,
  sanitizeRichBlock,
} from './MessageBundleSourceProjection.js';
import { projectedItem } from './message-selection-results.js';
import type {
  AdmissionCandidate,
  MessageSelectionAdmissionResult,
  MessageSelectionAuth,
  MessageSelectionInvalidReason,
  MessageSelectionReadResult,
} from './message-selection-types.js';

export {
  digestMessageBundleCliQuoteProjection,
  digestMessageBundleQuoteProjection,
  digestMessageBundleRichBlockProjection,
  MESSAGE_BUNDLE_CLI_QUOTE_DIGEST_DOMAIN,
  MESSAGE_BUNDLE_QUOTE_DIGEST_DOMAIN,
  MESSAGE_BUNDLE_RICH_BLOCK_DIGEST_DOMAIN,
  projectMessageBundleQuoteSourceV1,
  projectMessageBundleReadableContent,
};
export type {
  MessageSelectionAdmissionResult,
  MessageSelectionAuth,
  MessageSelectionAuthor,
  MessageSelectionInvalidReason,
  MessageSelectionProjectedItem,
  MessageSelectionReadResult,
  MessageSelectionTombstone,
  MessageSelectionTombstoneReason,
  ResolvedMessageSelectionItem,
} from './message-selection-types.js';

interface MessageSelectionResolverDeps {
  messageStore: Pick<IMessageStore, 'getById' | 'getByThreadAfter'>;
  threadStore: Pick<IThreadStore, 'get'>;
}

type AdmissionFailure = Extract<MessageSelectionAdmissionResult, { status: 'invalid' }>;

function invalid(reason: MessageSelectionInvalidReason, messageId?: string): AdmissionFailure {
  return messageId ? { status: 'invalid', reason, messageId } : { status: 'invalid', reason };
}

type MessageSelectionMessageItem = Extract<MessageBundleSelectionItem, { kind: 'message' }>;
type AdmissionCandidateResult = AdmissionCandidate | AdmissionFailure;

export class MessageSelectionResolver {
  constructor(private readonly deps: MessageSelectionResolverDeps) {}

  private async resolveMessageCandidate(
    item: MessageSelectionMessageItem,
    sourceThreadId: string,
    auth: MessageSelectionAuth,
  ): Promise<AdmissionCandidateResult> {
    const message = await this.deps.messageStore.getById(item.messageId);
    if (!isSelectableMessage(message, sourceThreadId, auth)) {
      return invalid('source_unavailable', item.messageId);
    }
    return {
      message,
      carrierItem: item,
      projectedItem: projectedItem(message, item, projectMessageBundleReadableContent(message)),
    };
  }

  private async resolveQuoteCandidate(
    item: MessageBundleSelectionQuoteItem,
    sourceThreadId: string,
    auth: MessageSelectionAuth,
  ): Promise<AdmissionCandidateResult> {
    const message = await this.deps.messageStore.getById(item.messageId);
    if (!isSelectableMessage(message, sourceThreadId, auth)) {
      return invalid('source_unavailable', item.messageId);
    }
    const projection = projectMessageBundleQuoteSourceV1(message);
    const offsets = quoteOffsets(item, projection);
    if (typeof offsets === 'string') return invalid(offsets, item.messageId);

    const carrierItem: MessageBundleItemV1 = {
      kind: 'quote',
      messageId: item.messageId,
      ...offsets,
      sourceProjectionVersion: MESSAGE_BUNDLE_QUOTE_PROJECTION_VERSION,
      sourceProjectionSha256: digestMessageBundleQuoteProjection(projection),
      ...(item.comment ? { comment: item.comment } : {}),
    };
    return {
      message,
      carrierItem,
      projectedItem: projectedItem(message, item, projection.slice(offsets.selectionStart, offsets.selectionEnd)),
    };
  }

  private async resolveCliQuoteCandidate(
    item: MessageBundleSelectionCliQuoteItem,
    sourceThreadId: string,
    auth: MessageSelectionAuth,
    resolveSourceRecords: SourceRecordResolver,
  ): Promise<AdmissionCandidateResult> {
    const source = await resolveSourceRecords(item.sourceMessageIds, item.messageId, sourceThreadId, auth);
    if (source.status !== 'resolved') return invalid('source_unavailable', item.messageId);
    const projection = projectCliSegment(source.records, item.segmentId);
    if (projection === null) return invalid('source_unavailable', item.messageId);
    const offsets = quoteOffsets(item, projection);
    if (typeof offsets === 'string') return invalid(offsets, item.messageId);

    const carrierItem: MessageBundleItemV1 = {
      kind: 'cli_quote',
      messageId: item.messageId,
      sourceMessageIds: source.records.map((record) => record.id),
      segmentId: item.segmentId,
      ...offsets,
      sourceProjectionVersion: MESSAGE_BUNDLE_CLI_QUOTE_PROJECTION_VERSION,
      sourceProjectionSha256: digestMessageBundleCliQuoteProjection(projection),
      ...(item.comment ? { comment: item.comment } : {}),
    };
    return {
      message: source.anchor,
      carrierItem,
      projectedItem: projectedItem(source.anchor, item, projection.slice(offsets.selectionStart, offsets.selectionEnd)),
    };
  }

  private async resolveRichBlockCandidate(
    item: MessageBundleSelectionRichBlockItem,
    sourceThreadId: string,
    auth: MessageSelectionAuth,
    resolveSourceRecords: SourceRecordResolver,
  ): Promise<AdmissionCandidateResult> {
    const source = await resolveSourceRecords(item.sourceMessageIds, item.messageId, sourceThreadId, auth);
    if (source.status !== 'resolved') return invalid('source_unavailable', item.messageId);
    const sourceBlock = richBlockFromRecords(source.records, item.blockId);
    if (!sourceBlock) return invalid('source_unavailable', item.messageId);
    const readableContent = readRichBlockFallback(sourceBlock);
    if (!readableContent?.trim()) return invalid('source_unavailable', item.messageId);

    return {
      message: source.anchor,
      carrierItem: {
        kind: 'rich_block',
        messageId: item.messageId,
        sourceMessageIds: source.records.map((record) => record.id),
        blockId: item.blockId,
        sourceProjectionVersion: MESSAGE_BUNDLE_RICH_BLOCK_PROJECTION_VERSION,
        sourceProjectionSha256: digestMessageBundleRichBlockProjection(sourceBlock),
      },
      projectedItem: projectedItem(source.anchor, item, readableContent, sanitizeRichBlock(sourceBlock)),
    };
  }

  private resolveCandidate(
    item: MessageBundleSelectionItem,
    sourceThreadId: string,
    auth: MessageSelectionAuth,
    resolveSourceRecords: SourceRecordResolver,
  ): Promise<AdmissionCandidateResult> {
    switch (item.kind) {
      case 'message':
        return this.resolveMessageCandidate(item, sourceThreadId, auth);
      case 'quote':
        return this.resolveQuoteCandidate(item, sourceThreadId, auth);
      case 'cli_quote':
        return this.resolveCliQuoteCandidate(item, sourceThreadId, auth, resolveSourceRecords);
      case 'rich_block':
        return this.resolveRichBlockCandidate(item, sourceThreadId, auth, resolveSourceRecords);
    }
  }

  async resolveForAdmission(input: unknown, auth: MessageSelectionAuth): Promise<MessageSelectionAdmissionResult> {
    const parsed = MessageBundleSelectionSchema.safeParse(input);
    if (!parsed.success) return invalid('invalid_selection');

    const sourceThread = await this.deps.threadStore.get(parsed.data.sourceThreadId);
    if (!canAccessSourceThread(sourceThread, auth)) return invalid('not_authorized');

    const resolveSourceRecords = createCanonicalSourceRecordResolver(this.deps.messageStore);
    const candidates: AdmissionCandidate[] = [];
    for (const item of parsed.data.items) {
      const result = await this.resolveCandidate(item, parsed.data.sourceThreadId, auth, resolveSourceRecords);
      if ('status' in result) return result;
      candidates.push(result);
    }

    candidates.sort((left, right) => {
      const timeDelta = getTimelineOrderTime(left.message) - getTimelineOrderTime(right.message);
      return timeDelta || left.message.id.localeCompare(right.message.id);
    });

    const carrier = MessageBundleCarrierV1Schema.parse({
      v: MESSAGE_BUNDLE_VERSION,
      sourceThreadId: parsed.data.sourceThreadId,
      ...(parsed.data.note ? { note: parsed.data.note } : {}),
      items: candidates.map((candidate) => candidate.carrierItem),
    });
    return {
      status: 'resolved',
      sourceThread: { id: sourceThread.id, title: sourceThread.title },
      carrier,
      items: candidates.map((candidate) => candidate.projectedItem),
    };
  }

  async resolveCarrier(input: unknown, auth: MessageSelectionAuth): Promise<MessageSelectionReadResult> {
    const resolveSourceRecords = createCanonicalSourceRecordResolver(this.deps.messageStore);
    return resolveMessageBundleCarrier({
      input,
      auth,
      ...this.deps,
      resolveSourceRecords,
    });
  }
}
