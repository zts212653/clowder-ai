import { MESSAGE_BUNDLE_MAX_ITEMS } from './schemas/message-bundle.schema.js';
import { isMessageFrom, type MessageFrom } from './types/message-lifecycle.js';
import { isValidRichBlock, type RichBlock } from './types/rich.js';

/** Current, authorized source projection. The durable carrier stores refs, never this body. */
export interface ResolvedMessageSelectionItem {
  status: 'available';
  kind: 'message' | 'quote' | 'cli_quote' | 'rich_block';
  messageId: string;
  sourceThreadId: string;
  from: MessageFrom;
  timestamp: number;
  readableContent: string;
  comment?: string;
  richBlock?: RichBlock;
}

export type MessageSelectionTombstoneReason = 'source_unavailable' | 'source_changed';

export interface MessageSelectionTombstone {
  status: 'tombstone';
  messageId: string;
  reason: MessageSelectionTombstoneReason;
}

export type MessageSelectionProjectedItem = ResolvedMessageSelectionItem | MessageSelectionTombstone;

/** GET /api/message-bundles/:messageId, shared by the producer and every presentation. */
export interface HydratedMessageBundle {
  messageBundleId: string;
  targetThreadId: string;
  createdBy: string;
  createdAt: number;
  note?: string;
  sourceThread: { id: string; title: string | null } | null;
  items: MessageSelectionProjectedItem[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && !Number.isNaN(new Date(value).getTime());
}

function isProjectedRichBlock(value: unknown): value is RichBlock {
  if (!isValidRichBlock(value)) return false;
  // Creation accepts text awaiting TTS. A hydrated player needs the resulting URL field.
  return value.kind !== 'audio' || typeof value.url === 'string';
}

function isProjectedItem(value: unknown): value is MessageSelectionProjectedItem {
  if (!isRecord(value) || !isId(value.messageId)) return false;
  if (value.status === 'tombstone') return value.reason === 'source_unavailable' || value.reason === 'source_changed';
  if (
    value.status !== 'available' ||
    typeof value.kind !== 'string' ||
    !['message', 'quote', 'cli_quote', 'rich_block'].includes(value.kind) ||
    !isId(value.sourceThreadId) ||
    !isMessageFrom(value.from) ||
    !isTimestamp(value.timestamp) ||
    typeof value.readableContent !== 'string' ||
    (value.comment !== undefined && typeof value.comment !== 'string')
  )
    return false;
  return value.kind === 'rich_block' || value.richBlock !== undefined ? isProjectedRichBlock(value.richBlock) : true;
}

/** Reject malformed reads at ingress, before nested values reach any React renderer. */
export function isHydratedMessageBundle(value: unknown): value is HydratedMessageBundle {
  if (!isRecord(value)) return false;
  const source = value.sourceThread;
  return (
    isId(value.messageBundleId) &&
    isId(value.targetThreadId) &&
    isId(value.createdBy) &&
    isTimestamp(value.createdAt) &&
    (value.note === undefined || typeof value.note === 'string') &&
    (source === null ||
      (isRecord(source) && isId(source.id) && (source.title === null || typeof source.title === 'string'))) &&
    Array.isArray(value.items) &&
    value.items.length <= MESSAGE_BUNDLE_MAX_ITEMS &&
    value.items.every(isProjectedItem)
  );
}
