import {
  findGeneratedTextConstructs,
  MESSAGE_BUNDLE_CLI_QUOTE_DIGEST_DOMAIN,
  MESSAGE_BUNDLE_CLI_QUOTE_DIGEST_DOMAIN_V2,
  MESSAGE_BUNDLE_CLI_QUOTE_PROJECTION_VERSION,
  MESSAGE_BUNDLE_CLI_QUOTE_PROJECTION_VERSION_V2,
  MESSAGE_BUNDLE_QUOTE_DIGEST_DOMAIN,
  MESSAGE_BUNDLE_QUOTE_DIGEST_DOMAIN_V2,
  MESSAGE_BUNDLE_QUOTE_DIGEST_DOMAIN_V3,
  MESSAGE_BUNDLE_QUOTE_PROJECTION_VERSION_V3,
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
import {
  digestMessageBundleCliQuoteProjection,
  digestMessageBundleCliQuoteProjectionV2,
  digestMessageBundleQuoteProjection,
  digestMessageBundleQuoteProjectionV2,
  digestMessageBundleQuoteProjectionV3,
  digestMessageBundleRichBlockProjection,
} from './MessageBundleProjectionDigest.js';
import {
  type BubbleGroupResolver,
  createCanonicalSourceResolvers,
  type SourceRecordResolver,
} from './MessageBundleSourceGroup.js';
import {
  canAccessSourceThread,
  projectCliSegment,
  projectCliSegmentReadable,
  projectCliSegmentReadableSource,
  projectMessageBundleGroupQuoteSourceV3,
  projectMessageBundleGroupReadableContent,
  projectMessageBundleQuoteSourceV1,
  projectMessageBundleQuoteSourceV2,
  projectMessageBundleReadableContent,
  readRichBlockFallback,
  richBlockFromRecords,
  sanitizeRichBlock,
} from './MessageBundleSourceProjection.js';
import { resolveExactQuoteAnchor, resolveReadableQuoteAnchor } from './message-bundle-quote-matching.js';
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
  digestMessageBundleCliQuoteProjectionV2,
  digestMessageBundleQuoteProjection,
  digestMessageBundleQuoteProjectionV2,
  digestMessageBundleQuoteProjectionV3,
  digestMessageBundleRichBlockProjection,
  MESSAGE_BUNDLE_CLI_QUOTE_DIGEST_DOMAIN,
  MESSAGE_BUNDLE_CLI_QUOTE_DIGEST_DOMAIN_V2,
  MESSAGE_BUNDLE_QUOTE_DIGEST_DOMAIN,
  MESSAGE_BUNDLE_QUOTE_DIGEST_DOMAIN_V2,
  MESSAGE_BUNDLE_QUOTE_DIGEST_DOMAIN_V3,
  MESSAGE_BUNDLE_RICH_BLOCK_DIGEST_DOMAIN,
  projectMessageBundleQuoteSourceV1,
  projectMessageBundleQuoteSourceV2,
  projectCliSegmentReadable,
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
    resolveBubbleGroup: BubbleGroupResolver,
  ): Promise<AdmissionCandidateResult> {
    // A chat bubble is a projection over several stored rows, and the human selected the bubble.
    // Resolving only the anchor row would silently drop the siblings' prose from what gets
    // exported or forwarded, so the whole canonical group is always resolved — not just when the
    // anchor happens to look unreadable on its own.
    const group = await resolveBubbleGroup(item.messageId, sourceThreadId, auth);
    if (group.status !== 'resolved') return invalid('source_unavailable', item.messageId);
    const readableContent = projectMessageBundleGroupReadableContent(group.records);
    if (!readableContent.trim()) return invalid('source_unavailable', item.messageId);
    return {
      message: group.anchor,
      carrierItem: item,
      projectedItem: projectedItem(group.anchor, item, readableContent),
    };
  }

  private async resolveQuoteCandidate(
    item: MessageBundleSelectionQuoteItem,
    sourceThreadId: string,
    auth: MessageSelectionAuth,
    resolveBubbleGroup: BubbleGroupResolver,
  ): Promise<AdmissionCandidateResult> {
    // The human highlighted text inside one browser bubble. A visible range can cross storage-row
    // boundaries, so new carriers use a bubble projection instead of guessing which row owns it.
    // Historical v1/v2 row carriers remain readable in MessageBundleCarrierResolver.
    const group = await resolveBubbleGroup(item.messageId, sourceThreadId, auth);
    if (group.status !== 'resolved') return invalid('source_unavailable', item.messageId);
    // Only the browser can see the rendered plane. The renderer puts characters on screen with
    // no source counterpart — footnote labels, KaTeX glyphs, component loading states — so a
    // server-side projection can never prove that the human's selection was unique on screen.
    // The selecting browser therefore asserts that count, and admission requires it to be 1.
    if (item.renderedOccurrences !== 1) {
      return invalid('ambiguous_quote', item.messageId);
    }
    // Defence in depth for the constructs we can name from the source alone.
    if (findGeneratedTextConstructs(projectMessageBundleGroupReadableContent(group.records)).length > 0) {
      return invalid('unsupported_source', item.messageId);
    }

    const projection = projectMessageBundleGroupQuoteSourceV3(group.records);
    const offsets = resolveReadableQuoteAnchor(item, projection);
    if (typeof offsets === 'string') return invalid(offsets, item.messageId);

    const carrierItem: MessageBundleItemV1 = {
      kind: 'quote',
      messageId: group.anchor.id,
      ...offsets,
      sourceProjectionVersion: MESSAGE_BUNDLE_QUOTE_PROJECTION_VERSION_V3,
      sourceProjectionSha256: digestMessageBundleQuoteProjectionV3(projection),
      ...(item.comment ? { comment: item.comment } : {}),
    };
    return {
      message: group.anchor,
      carrierItem,
      projectedItem: projectedItem(group.anchor, item, projection.slice(offsets.selectionStart, offsets.selectionEnd)),
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
    const isReadableProjection = item.sourceProjectionVersion === MESSAGE_BUNDLE_CLI_QUOTE_PROJECTION_VERSION_V2;
    const projection = isReadableProjection
      ? projectCliSegmentReadableSource(source.records, item.segmentId)
      : projectCliSegment(source.records, item.segmentId);
    if (projection === null) return invalid('source_unavailable', item.messageId);
    if (isReadableProjection && item.renderedOccurrences !== 1) {
      return invalid('ambiguous_quote', item.messageId);
    }
    if (isReadableProjection && findGeneratedTextConstructs(projection).length > 0) {
      return invalid('unsupported_source', item.messageId);
    }
    const canonicalProjection = isReadableProjection ? projectCliSegmentReadable(projection) : projection;
    const offsets = isReadableProjection
      ? resolveReadableQuoteAnchor(item, canonicalProjection)
      : resolveExactQuoteAnchor(item, canonicalProjection);
    if (typeof offsets === 'string') return invalid(offsets, item.messageId);

    const carrierItem: MessageBundleItemV1 = {
      kind: 'cli_quote',
      messageId: item.messageId,
      sourceMessageIds: source.records.map((record) => record.id),
      segmentId: item.segmentId,
      ...offsets,
      sourceProjectionVersion: isReadableProjection
        ? MESSAGE_BUNDLE_CLI_QUOTE_PROJECTION_VERSION_V2
        : MESSAGE_BUNDLE_CLI_QUOTE_PROJECTION_VERSION,
      sourceProjectionSha256: isReadableProjection
        ? digestMessageBundleCliQuoteProjectionV2(canonicalProjection)
        : digestMessageBundleCliQuoteProjection(canonicalProjection),
      ...(item.comment ? { comment: item.comment } : {}),
    };
    return {
      message: source.anchor,
      carrierItem,
      projectedItem: projectedItem(
        source.anchor,
        item,
        canonicalProjection.slice(offsets.selectionStart, offsets.selectionEnd),
      ),
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
    resolveBubbleGroup: BubbleGroupResolver,
  ): Promise<AdmissionCandidateResult> {
    switch (item.kind) {
      case 'message':
        return this.resolveMessageCandidate(item, sourceThreadId, auth, resolveBubbleGroup);
      case 'quote':
        return this.resolveQuoteCandidate(item, sourceThreadId, auth, resolveBubbleGroup);
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

    const { resolveSourceRecords, resolveBubbleGroup } = createCanonicalSourceResolvers(this.deps.messageStore);
    const candidates: AdmissionCandidate[] = [];
    for (const item of parsed.data.items) {
      const result = await this.resolveCandidate(
        item,
        parsed.data.sourceThreadId,
        auth,
        resolveSourceRecords,
        resolveBubbleGroup,
      );
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
    const { resolveSourceRecords, resolveBubbleGroup } = createCanonicalSourceResolvers(this.deps.messageStore);
    return resolveMessageBundleCarrier({
      input,
      auth,
      ...this.deps,
      resolveSourceRecords,
      resolveBubbleGroup,
    });
  }
}
