import type { MessageBundleCarrierV1, MessageBundleItemV1, RichBlock } from '@cat-cafe/shared';
import type { StoredMessage } from '../stores/ports/MessageStore.js';
import type { Thread } from '../stores/ports/ThreadStore.js';

export interface MessageSelectionAuth {
  userId: string;
}

export type MessageSelectionInvalidReason =
  | 'invalid_selection'
  | 'not_authorized'
  | 'source_unavailable'
  | 'quote_mismatch'
  | 'ambiguous_quote'
  | 'unsupported_source';

export type MessageSelectionTombstoneReason = 'source_unavailable' | 'source_changed';

export type MessageSelectionAuthor = { kind: 'user'; userId: string } | { kind: 'cat'; catId: string };

export interface ResolvedMessageSelectionItem {
  status: 'available';
  kind: 'message' | 'quote' | 'cli_quote' | 'rich_block';
  messageId: string;
  sourceThreadId: string;
  author: MessageSelectionAuthor;
  timestamp: number;
  readableContent: string;
  comment?: string;
  richBlock?: RichBlock;
}

export interface MessageSelectionTombstone {
  status: 'tombstone';
  messageId: string;
  reason: MessageSelectionTombstoneReason;
}

export type MessageSelectionProjectedItem = ResolvedMessageSelectionItem | MessageSelectionTombstone;

export type MessageSelectionAdmissionResult =
  | {
      status: 'resolved';
      sourceThread: Pick<Thread, 'id' | 'title'>;
      carrier: MessageBundleCarrierV1;
      items: ResolvedMessageSelectionItem[];
    }
  | { status: 'invalid'; reason: MessageSelectionInvalidReason; messageId?: string };

export type MessageSelectionReadResult =
  | {
      status: 'resolved';
      sourceThread: Pick<Thread, 'id' | 'title'> | null;
      note?: string;
      items: MessageSelectionProjectedItem[];
    }
  | { status: 'invalid'; reason: 'invalid_carrier' };

export interface AdmissionCandidate {
  message: StoredMessage;
  carrierItem: MessageBundleItemV1;
  projectedItem: ResolvedMessageSelectionItem;
}
