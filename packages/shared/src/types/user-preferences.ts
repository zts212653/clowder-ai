/**
 * User Preferences (F166)
 * UI-level preferences persisted to .cat-cafe/user-preferences.json.
 * Separate from cat-catalog.json (configuration, not preference).
 */

import type { ChatBackgroundPreferences } from '../chat-background.js';
import type { ConversationViewPreferences } from '../conversation-view-preference.js';
import type { IgnoredItemPreferences } from '../ignored-item-preference.js';
import type { ProcessTalkMode } from '../process-talk-preference.js';
import type { MessageWorkDisposition } from './queue-receipt.js';

export type MessageDispositionPreferenceSource = 'thread' | 'global' | 'product';

export interface MessageDispositionPreferences {
  /** Owner-wide fallback. Missing inherits the product default. */
  global?: MessageWorkDisposition;
  /** Per-thread override. Missing entry inherits global/product. */
  threads?: Record<string, MessageWorkDisposition>;
}

export interface MessageDispositionPreferenceSnapshot {
  productDefault: MessageWorkDisposition;
  global: MessageWorkDisposition | null;
  thread: MessageWorkDisposition | null;
  effective: MessageWorkDisposition;
  source: MessageDispositionPreferenceSource;
}

/** F277: owner-scoped Group read model projected from per-thread metadata. */
export interface ThreadAttentionGroup {
  id: string;
  name?: string;
  threadIds: string[];
}

/** F277: private presentation state keyed only by a stable Group anchor. */
export type ThreadAttentionMemberSort = 'manual' | 'running-first';

export interface ThreadAttentionPreferences {
  /** Most recently used destinations first; membership remains in thread metadata. */
  recentGroupIds?: string[];
  aliases?: Record<string, string>;
  open?: Record<string, boolean>;
  /** F322: collapsed Groups reveal attention shortcuts unless explicitly disabled. */
  collapsedPeek?: Record<string, boolean>;
  /** Missing inherits manual order. Running-first is a view; membership order remains durable truth. */
  memberSort?: Record<string, ThreadAttentionMemberSort>;
}

export type BubbleDisplayDefaultPreference = 'expanded' | 'collapsed';

export interface BubbleDefaultPreferences {
  /** F322: personal default for execution records. Missing inherits runtime/product configuration. */
  cliOutput?: BubbleDisplayDefaultPreference;
}

export interface UserPreferences {
  /** F322: private whole-window image preferences. No TTL, message or export content. */
  chatBackgrounds?: ChatBackgroundPreferences;
  /** F322: personal display only, per authenticated user, no TTL and no thread override. */
  processTalk?: { owners?: Record<string, { mode: ProcessTalkMode }> };
  /** #1466: durable personal guide receipts. Keys include operator and guide version. */
  onboardingGuides?: Record<string, { status: 'pending' | 'dismissed' | 'completed'; updatedAt: number }>;
  /** Happening Now per-project presentation only; persisted without expiry. */
  liveProjectFolds?: Record<string, boolean>;
  waitingProjectFolds?: Record<string, boolean>;
  deploymentWaitFolds?: Record<string, boolean>;
  /** F322: owner-private ignored work/request coordinates. No TTL or canonical lifecycle effect. */
  ignoredItems?: IgnoredItemPreferences;
  /** F321: background curation preference and its durable first-enable boundary. */
  memoryCuration?: { enabled: boolean; startedAt?: number; curatorCatId?: string };
  /** F166: Custom display order of cats. catIds not in this list fall back to cat-template.json order. */
  catOrder?: string[];
  /** F264: author-declared current-work/next-work preference inheritance. */
  messageDisposition?: MessageDispositionPreferences;
  /** F277: owner-only Group aliases and fold overrides. Membership lives in thread metadata. No TTL. */
  threadAttention?: ThreadAttentionPreferences;
  /** F322: owner-only presentation defaults. No TTL. */
  bubbleDefaults?: BubbleDefaultPreferences;
  /** F322: owner-only per-thread conversation presentation. No TTL. */
  conversationViews?: ConversationViewPreferences;
}
