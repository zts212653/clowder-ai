import type { RecallMatchRank, RecallMatchType, RecallResolverFamily, RecallResultStatus } from '@cat-cafe/shared';

export type MemoryCueStatus = 'presented_unreported' | 'drilled' | 'applied' | 'dismissed' | 'invalidated';

export interface RecallResultItem {
  sourceUnavailableReason?: 'source_corrected' | 'source_forgotten' | 'scope_revoked';
  title: string;
  titleStatus?: 'loading' | 'unavailable';
  /** Null explicitly means this source has no verified owner-readable destination. */
  href?: string | null;
  matchRank?: RecallMatchRank;
  matchType?: RecallMatchType;
  authority?: string;
  updatedAt?: string;
  sourceType?: string;
  anchor?: string;
  snippet?: string;
  /** F263 B.5: whether this specific candidate was consumed (used) by the cat */
  consumed?: boolean;
}

export interface RecallEvent {
  id: string;
  catId?: string;
  invocationId?: string;
  sourceEventId?: string;
  messageId?: string;
  replyTimestamp?: number;
  consumedCount?: number;
  cueStatus?: MemoryCueStatus;
  resolverFamily?: RecallResolverFamily;
  cueId?: string;
  sourceRevision?: string;
  toolName?: string;
  query: string;
  mode?: string;
  scope?: string;
  timestamp: number;
  resultCount?: number;
  resultStatus?: RecallResultStatus;
  results?: RecallResultItem[];
  /** F263 B.5: 'push' (system-injected) or 'pull' (cat-initiated search) */
  source?: 'push' | 'pull';
  /** F263 B.5: for push events, which pipeline (e.g. 'session_bootstrap', 'cold_context') */
  pushSurface?: string;
  /** F263 B.5: whether the cat inspected the results */
  inspected?: boolean;
  /** F263 B.5: 'used' or 'ignored' */
  outcome?: 'used' | 'ignored';
}

export interface RecallSourceView {
  sourceUnavailableReason?: RecallResultItem['sourceUnavailableReason'];
  anchor: string;
  invocationId?: string;
  cueId?: string;
  sourceRevision?: string;
  title?: string;
  titleStatus?: 'unavailable';
  kind?: string;
  href: string | null;
}
