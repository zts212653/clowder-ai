import {
  MESSAGE_BUNDLE_CLI_QUOTE_PROJECTION_VERSION_V2,
  MESSAGE_BUNDLE_QUOTE_PROJECTION_VERSION,
  MESSAGE_BUNDLE_QUOTE_PROJECTION_VERSION_V2,
  MESSAGE_BUNDLE_QUOTE_PROJECTION_VERSION_V3,
  MESSAGE_BUNDLE_RICH_BLOCK_PROJECTION_VERSION,
  MessageBundleCarrierV1Schema,
  type MessageBundleItemV1,
} from '@cat-cafe/shared';
import type { IMessageStore } from '../stores/ports/MessageStore.js';
import type { IThreadStore } from '../stores/ports/ThreadStore.js';
import {
  digestMessageBundleCliQuoteProjection,
  digestMessageBundleCliQuoteProjectionV2,
  digestMessageBundleQuoteProjection,
  digestMessageBundleQuoteProjectionV2,
  digestMessageBundleQuoteProjectionV3,
  digestMessageBundleRichBlockProjection,
} from './MessageBundleProjectionDigest.js';
import type { BubbleGroupResolver, SourceRecordResolver } from './MessageBundleSourceGroup.js';
import {
  canAccessSourceThread,
  isSelectableMessage,
  projectCliSegment,
  projectCliSegmentReadable,
  projectCliSegmentReadableSource,
  projectMessageBundleGroupQuoteSourceV3,
  projectMessageBundleGroupReadableContent,
  projectMessageBundleQuoteSourceV1,
  projectMessageBundleQuoteSourceV2,
  readRichBlockFallback,
  richBlockFromRecords,
  sanitizeRichBlock,
} from './MessageBundleSourceProjection.js';
import { projectedItem, tombstone } from './message-selection-results.js';
import type {
  MessageSelectionAuth,
  MessageSelectionProjectedItem,
  MessageSelectionReadResult,
} from './message-selection-types.js';

interface ResolveMessageBundleCarrierInput {
  input: unknown;
  auth: MessageSelectionAuth;
  messageStore: Pick<IMessageStore, 'getById'>;
  threadStore: Pick<IThreadStore, 'get'>;
  resolveSourceRecords: SourceRecordResolver;
  resolveBubbleGroup: BubbleGroupResolver;
}

type CarrierResolutionContext = Omit<ResolveMessageBundleCarrierInput, 'input'> & { sourceThreadId: string };

function verifiedCliCarrierProjection(
  item: Extract<MessageBundleItemV1, { kind: 'cli_quote' }>,
  records: Parameters<typeof projectCliSegment>[0],
): string | null {
  const isReadableProjection = item.sourceProjectionVersion === MESSAGE_BUNDLE_CLI_QUOTE_PROJECTION_VERSION_V2;
  const rawProjection = isReadableProjection
    ? projectCliSegmentReadableSource(records, item.segmentId)
    : projectCliSegment(records, item.segmentId);
  if (rawProjection === null) return null;
  const projection = isReadableProjection ? projectCliSegmentReadable(rawProjection) : rawProjection;
  const expectedDigest = isReadableProjection
    ? digestMessageBundleCliQuoteProjectionV2(projection)
    : digestMessageBundleCliQuoteProjection(projection);
  return expectedDigest === item.sourceProjectionSha256 ? projection : null;
}

async function resolveBubbleQuoteCarrierItem(
  item: Extract<MessageBundleItemV1, { kind: 'quote' }>,
  context: CarrierResolutionContext,
): Promise<MessageSelectionProjectedItem> {
  const group = await context.resolveBubbleGroup(item.messageId, context.sourceThreadId, context.auth);
  if (group.status !== 'resolved') {
    return tombstone(item.messageId, group.status === 'changed' ? 'source_changed' : 'source_unavailable');
  }
  const projection = projectMessageBundleGroupQuoteSourceV3(group.records);
  const digestMatches = digestMessageBundleQuoteProjectionV3(projection) === item.sourceProjectionSha256;
  if (!digestMatches || item.selectionEnd > projection.length) return tombstone(item.messageId, 'source_changed');
  return projectedItem(group.anchor, item, projection.slice(item.selectionStart, item.selectionEnd));
}

async function resolveMessageCarrierItem(
  item: Extract<MessageBundleItemV1, { kind: 'message' }>,
  context: CarrierResolutionContext,
): Promise<MessageSelectionProjectedItem> {
  // Re-reading a stored bundle must show the same bubble the human selected, so the canonical
  // group is resolved here too — anything less would silently drop sibling rows from the card.
  const group = await context.resolveBubbleGroup(item.messageId, context.sourceThreadId, context.auth);
  if (group.status !== 'resolved') return tombstone(item.messageId, 'source_unavailable');
  const readableContent = projectMessageBundleGroupReadableContent(group.records);
  if (!readableContent.trim()) return tombstone(item.messageId, 'source_unavailable');
  return projectedItem(group.anchor, item, readableContent);
}

async function resolveQuoteCarrierItem(
  item: Extract<MessageBundleItemV1, { kind: 'quote' }>,
  context: CarrierResolutionContext,
): Promise<MessageSelectionProjectedItem> {
  if (item.sourceProjectionVersion === MESSAGE_BUNDLE_QUOTE_PROJECTION_VERSION_V3) {
    return resolveBubbleQuoteCarrierItem(item, context);
  }

  const message = await context.messageStore.getById(item.messageId);
  if (!isSelectableMessage(message, context.sourceThreadId, context.auth)) {
    return tombstone(item.messageId, 'source_unavailable');
  }
  // Each carrier is re-resolved in the exact plane it was admitted in, so a v1 quote
  // stored before the readable-text plane existed keeps rendering instead of tombstoning.
  const isV2 = item.sourceProjectionVersion === MESSAGE_BUNDLE_QUOTE_PROJECTION_VERSION_V2;
  const projection = isV2 ? projectMessageBundleQuoteSourceV2(message) : projectMessageBundleQuoteSourceV1(message);
  const expectedDigest = isV2
    ? digestMessageBundleQuoteProjectionV2(projection)
    : digestMessageBundleQuoteProjection(projection);
  const digestMatches =
    (isV2 || item.sourceProjectionVersion === MESSAGE_BUNDLE_QUOTE_PROJECTION_VERSION) &&
    expectedDigest === item.sourceProjectionSha256;
  if (!digestMatches || item.selectionEnd > projection.length) {
    return tombstone(item.messageId, 'source_changed');
  }
  return projectedItem(message, item, projection.slice(item.selectionStart, item.selectionEnd));
}

async function resolveGroupedCarrierItem(
  item: Extract<MessageBundleItemV1, { kind: 'cli_quote' | 'rich_block' }>,
  context: CarrierResolutionContext,
): Promise<MessageSelectionProjectedItem> {
  const source = await context.resolveSourceRecords(
    item.sourceMessageIds,
    item.messageId,
    context.sourceThreadId,
    context.auth,
  );
  if (source.status !== 'resolved') {
    return tombstone(item.messageId, source.status === 'changed' ? 'source_changed' : 'source_unavailable');
  }

  if (item.kind === 'cli_quote') {
    const projection = verifiedCliCarrierProjection(item, source.records);
    if (!projection || item.selectionEnd > projection.length) {
      return tombstone(item.messageId, 'source_changed');
    }
    return projectedItem(source.anchor, item, projection.slice(item.selectionStart, item.selectionEnd));
  }

  const sourceBlock = richBlockFromRecords(source.records, item.blockId);
  const digestMatches =
    sourceBlock !== null &&
    item.sourceProjectionVersion === MESSAGE_BUNDLE_RICH_BLOCK_PROJECTION_VERSION &&
    digestMessageBundleRichBlockProjection(sourceBlock) === item.sourceProjectionSha256;
  const readableContent = sourceBlock ? readRichBlockFallback(sourceBlock) : null;
  if (!digestMatches || !sourceBlock || !readableContent?.trim()) {
    return tombstone(item.messageId, 'source_changed');
  }
  return projectedItem(source.anchor, item, readableContent, sanitizeRichBlock(sourceBlock));
}

function resolveCarrierItem(
  item: MessageBundleItemV1,
  context: CarrierResolutionContext,
): Promise<MessageSelectionProjectedItem> {
  switch (item.kind) {
    case 'message':
      return resolveMessageCarrierItem(item, context);
    case 'quote':
      return resolveQuoteCarrierItem(item, context);
    case 'cli_quote':
    case 'rich_block':
      return resolveGroupedCarrierItem(item, context);
  }
}

export async function resolveMessageBundleCarrier({
  input,
  auth,
  messageStore,
  threadStore,
  resolveSourceRecords,
  resolveBubbleGroup,
}: ResolveMessageBundleCarrierInput): Promise<MessageSelectionReadResult> {
  const parsed = MessageBundleCarrierV1Schema.safeParse(input);
  if (!parsed.success) return { status: 'invalid', reason: 'invalid_carrier' };

  const sourceThread = await threadStore.get(parsed.data.sourceThreadId);
  if (!canAccessSourceThread(sourceThread, auth)) {
    return {
      status: 'resolved',
      sourceThread: null,
      ...(parsed.data.note ? { note: parsed.data.note } : {}),
      items: parsed.data.items.map((item) => tombstone(item.messageId, 'source_unavailable')),
    };
  }

  const items: MessageSelectionProjectedItem[] = [];
  for (const item of parsed.data.items) {
    items.push(
      await resolveCarrierItem(item, {
        auth,
        messageStore,
        threadStore,
        resolveSourceRecords,
        resolveBubbleGroup,
        sourceThreadId: parsed.data.sourceThreadId,
      }),
    );
  }

  return {
    status: 'resolved',
    sourceThread: { id: sourceThread.id, title: sourceThread.title },
    ...(parsed.data.note ? { note: parsed.data.note } : {}),
    items,
  };
}
